/**
 * The packaging check for the Java agent (scripts/check-java-agent.cjs, run by electron-builder.cjs
 * before each package): every installer carries the three jars, and none holds native code.
 */
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildJavaAgent } from '../scripts/build-java-agent.mjs';
import { buildJava } from './java-agent-helpers';

const require = createRequire(import.meta.url);
const { JAVA_AGENT_JARS, zipEntries, checkJavaAgent } = require('../scripts/check-java-agent.cjs') as {
  JAVA_AGENT_JARS: string[];
  zipEntries(file: string): string[];
  checkJavaAgent(dir: string): void;
};

/** A zip with empty, stored entries: enough for the check, which reads only the central directory. */
function zip(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(n.length, 28);
    // An extra field and a comment, which the reader must step over.
    central.writeUInt16LE(4, 30);
    central.writeUInt16LE(3, 32);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n);
    centrals.push(central, n, Buffer.from([0xca, 0xfe, 0, 0]), Buffer.from('abc'));
    offset += local.length + n.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let work: string;
beforeAll(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'wirescry packaging-'));
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

/** A folder with the three jars, `change` replacing some of them (null leaves one out). */
async function jars(change: Record<string, Buffer | null> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(work, 'build-'));
  for (const name of JAVA_AGENT_JARS) {
    const bytes =
      name in change ? change[name] : zip(['META-INF/MANIFEST.MF', 'com/wirescry/agent/Stub.class']);
    if (bytes) await writeFile(path.join(dir, name), bytes);
  }
  return dir;
}

describe('the Java agent packaging check', () => {
  it('ships the stub, the agent and its weaver, not the attacher yet', () => {
    expect(JAVA_AGENT_JARS).toEqual([
      'wirescry-agent.jar',
      'wirescry-agent-impl.jar',
      'wirescry-agent-weaver.jar',
    ]);
  });

  it('reads a zip’s entry names', async () => {
    const file = path.join(work, 'names.zip');
    await writeFile(file, zip(['a.class', 'META-INF/LICENSE', 'net/bytebuddy/Ü.class']));
    expect(zipEntries(file)).toEqual(['a.class', 'META-INF/LICENSE', 'net/bytebuddy/Ü.class']);
  });

  it('passes jars of classes', async () => {
    const dir = await jars();
    expect(() => checkJavaAgent(dir)).not.toThrow();
  });

  // CI's check jobs have a JDK (and fail without one), so this runs on every OS there.
  it.skipIf(!buildJava)(
    'passes the agent as built',
    async () => {
      const dir = path.join(work, 'built');
      const built = (await buildJavaAgent(dir)) as Record<string, { file: string }>;
      expect(() => checkJavaAgent(dir)).not.toThrow();
      // Byte Buddy's thousands of classes are all read.
      expect(zipEntries(built.weaver!.file).length).toBeGreaterThan(1000);
    },
    180_000,
  );

  it('refuses a missing jar', async () => {
    const dir = await jars({ 'wirescry-agent-weaver.jar': null });
    expect(() => checkJavaAgent(dir)).toThrow(
      /No Java agent at .*wirescry-agent-weaver\.jar.*build-java-agent/,
    );
  });

  for (const library of ['lib/x86_64/libjni.so', 'native/agent.DLL', 'darwin/libx.dylib', 'libold.jnilib']) {
    it(`refuses native code: ${library}`, async () => {
      const dir = await jars({ 'wirescry-agent-impl.jar': zip(['a.class', library]) });
      expect(() => checkJavaAgent(dir)).toThrow(`wirescry-agent-impl.jar holds native libraries: ${library}`);
    });
  }

  it('refuses a file that isn’t a zip', async () => {
    const dir = await jars({
      'wirescry-agent.jar': Buffer.from('not a zip at all, but long enough to read'),
    });
    expect(() => checkJavaAgent(dir)).toThrow(/isn't a zip/);
  });

  it('refuses a damaged central directory', async () => {
    const bytes = zip(['a.class']);
    // The directory's first signature.
    bytes.writeUInt32LE(0, bytes.length - 22 - (46 + 'a.class'.length + 4 + 3));
    const dir = await jars({ 'wirescry-agent.jar': bytes });
    expect(() => checkJavaAgent(dir)).toThrow(/bad central directory/);
  });
});

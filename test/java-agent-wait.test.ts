/**
 * waitForOutput: waiting for a program's output, and saying what happened when it doesn't come.
 * Java agent tests failed on Windows CI with only "expected '' to contain 'ready'", which can't
 * tell a hang from a crash or a slow start.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildJava, run, waitForOutput, type Run } from './java-agent-helpers';

const node = process.execPath;
const started: Run[] = [];
const start = (args: string[]): Run => {
  const r = run(node, args);
  started.push(r);
  return r;
};

afterEach(async () => {
  for (const r of started.splice(0)) {
    if (r.child.exitCode === null && r.child.signalCode === null) r.child.kill('SIGKILL');
    await r.exit;
  }
});

/** The error waitForOutput fails with. */
async function failure(promise: Promise<void>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected waitForOutput to fail');
}

describe('waitForOutput', () => {
  it('returns once the text is printed, even after a delay', async () => {
    const r = start(['-e', "setTimeout(() => console.log('ready now'), 200); setTimeout(() => {}, 5000)"]);
    await waitForOutput(r, 'ready', 5000);
    expect(r.stdout()).toContain('ready now');
  });

  it('says a program that never prints it is still running, with its stdout and stderr', async () => {
    const r = start([
      '-e',
      "console.log('starting'); console.error('stuck on a lock'); setTimeout(() => {}, 60000)",
    ]);
    const message = await failure(waitForOutput(r, 'ready', 500));
    expect(message).toMatch(/^no "ready" after \d+ ms; the program is still running\./);
    expect(message).toContain('stdout:\nstarting');
    expect(message).toContain('stderr:\nstuck on a lock');
    // Not a JVM: no thread dump is asked for.
    expect(message).not.toContain('threads:');
  });

  it('says a program exited, and how', async () => {
    const r = start(['-e', "console.error('crashed'); process.exit(3)"]);
    await r.exit;
    const message = await failure(waitForOutput(r, 'ready', 300));
    expect(message).toContain('the program exited (code 3, signal null).');
    expect(message).toContain('stderr:\ncrashed');
  });

  it('keeps only the end of long output', async () => {
    const r = start(['-e', "process.stderr.write('x'.repeat(20000) + 'END'); setTimeout(() => {}, 60000)"]);
    await expect.poll(() => r.stderr().endsWith('END')).toBe(true);
    const message = await failure(waitForOutput(r, 'ready', 300));
    expect(message).toContain('…');
    expect(message).toContain('END');
    expect(message.length).toBeLessThan(10_000);
  });

  it.skipIf(!buildJava)(
    "adds a JVM's threads when it's still running",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-wait-'));
      try {
        const source = path.join(dir, 'Sleeper.java');
        await writeFile(
          source,
          'public class Sleeper { public static void main(String[] a) throws Exception { Thread.sleep(60000); } }',
        );
        // A JDK 11+ java runs a source file directly.
        const r = run(buildJava!, [source]);
        started.push(r);
        // Long enough for the JVM to be up, so it can answer jstack.
        const message = await failure(waitForOutput(r, 'ready', 5000));
        expect(message).toContain('the program is still running');
        expect(message).toContain('threads:');
        expect(message).toMatch(/"main"[\s\S]*Sleeper\.main/);
      } finally {
        for (const r of started.splice(0)) {
          r.child.kill('SIGKILL');
          await r.exit;
        }
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

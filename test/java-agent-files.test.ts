/** Wirescry's side of the Java agent's files (src/backend/java/agent-files.ts). */
import { mkdtemp, mkdir, chmod, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatControl,
  installAgentJars,
  makeAgentFolder,
  parseStatus,
  readStatuses,
  writeWhole,
  type AgentControl,
} from '../src/backend/java/agent-files';

const control: AgentControl = {
  impl: 'jars/wirescry-agent-impl-0.1.30-1a2b3c4d.jar',
  enabled: true,
  startup: false,
  proxyPort: 8000,
  config: 3,
  seq: 7,
  detached: [],
};

const status = (extra: Record<string, string> = {}, drop: string[] = []) => {
  const fields: Record<string, string> = {
    protocol: '1',
    agentVersion: '0.1.30',
    route: 'attach',
    id: 'a1',
    pid: '4242',
    java: '21.0.5',
    enabled: 'true',
    reason: 'on',
    appliedConfig: '3',
    port: '8000',
    hooks: '',
    beat: '2',
    ...extra,
  };
  for (const key of drop) delete fields[key];
  return `${Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\nend=1\n`;
};

describe('the control file', () => {
  it('writes every setting, one per line, ending with end=1', () => {
    expect(
      formatControl({
        ...control,
        wirescryPid: 99,
        statusDelayMs: 0,
        caSha256: 'a'.repeat(64),
        detached: ['a1', 'b_2'],
      }),
    ).toBe(
      [
        'protocol=1',
        'impl=jars/wirescry-agent-impl-0.1.30-1a2b3c4d.jar',
        'enabled=true',
        'startup=false',
        'proxyPort=8000',
        'config=3',
        'seq=7',
        'wirescryPid=99',
        'statusDelayMs=0',
        `caSha256=${'a'.repeat(64)}`,
        'detached=a1,b_2',
        'end=1',
        '',
      ].join('\n'),
    );
    expect(formatControl(control)).not.toMatch(/wirescryPid|statusDelayMs|caSha256/);
  });

  it.each<[string, Partial<AgentControl>]>([
    ['a jar outside jars/', { impl: '../evil.jar' }],
    ['a jar name with a slash', { impl: 'jars/wirescry-agent-impl-1/../../x.jar' }],
    ['port 0', { proxyPort: 0 }],
    ['port 65536', { proxyPort: 65536 }],
    ['a fractional port', { proxyPort: 80.5 }],
    ['a negative config', { config: -1 }],
    ['a non-integer seq', { seq: 1.5 }],
    ['a negative pid', { wirescryPid: -2 }],
    ['a status delay over a minute', { statusDelayMs: 60_001 }],
    ['an uppercase CA hash', { caSha256: 'A'.repeat(64) }],
    ['an id with a comma', { detached: ['a,b'] }],
    ['an id with a newline', { detached: ['a\nenabled=false'] }],
  ])('refuses %s', (_, change) => {
    expect(() => formatControl({ ...control, ...change })).toThrow();
  });
});

describe('status files', () => {
  it('reads what an agent writes', () => {
    expect(parseStatus(status({ caSha256: 'b'.repeat(64), hooks: 'trust,selector' }))).toEqual({
      agentVersion: '0.1.30',
      route: 'attach',
      id: 'a1',
      pid: 4242,
      java: '21.0.5',
      enabled: true,
      reason: 'on',
      appliedConfig: 3,
      port: 8000,
      caSha256: 'b'.repeat(64),
      hooks: ['trust', 'selector'],
      beat: 2,
    });
    // Before any good read, an agent has no port and applied config -1.
    expect(
      parseStatus(status({ appliedConfig: '-1', enabled: 'false', reason: 'no-control' }, ['port'])),
    ).toMatchObject({
      appliedConfig: -1,
      enabled: false,
    });
    expect(parseStatus(status({ newField: 'from a newer agent' }))).toBeDefined();
    expect(parseStatus(status().replaceAll('\n', '\r\n'))).toBeDefined();
  });

  it.each<[string, string]>([
    ['without end=1 (half-written)', status().replace('end=1\n', '')],
    ['with lines after end=1', `${status()}enabled=false\n`],
    ['from a newer protocol', status({ protocol: '2' })],
    ['from protocol 0', status({ protocol: '0' })],
    ['with a key twice', `enabled=false\n${status()}`],
    ['with a line that has no =', status().replace('hooks=', 'hooks')],
    ['with an unknown route', status({ route: 'magic' })],
    ['with a bad id', status({ id: '../x' })],
    ['with pid 0', status({ pid: '0' })],
    ['with a huge number', status({ pid: '9'.repeat(19) })],
    ['with enabled=yes', status({ enabled: 'yes' })],
    ['with an odd reason', status({ reason: 'On Now' })],
    ['with port 70000', status({ port: '70000' })],
    ['with a short CA hash', status({ caSha256: 'abc' })],
    ['with beat 0', status({ beat: '0' })],
    ['with odd hooks', status({ hooks: 'trust;rm -rf' })],
    ['with a Java version full of spaces', status({ java: 'a b' })],
    ['empty', ''],
  ])('ignores one %s', (_, text) => {
    expect(parseStatus(text)).toBeUndefined();
  });
});

describe('files on disk', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry agent-files-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a file whole, readable only by this user', async () => {
    const file = path.join(dir, 'control.properties');
    await writeFile(file, 'old');
    await writeWhole(file, 'new');
    expect(await readFile(file, 'utf8')).toBe('new');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['control.properties']);
  });

  it('tries the rename again while Windows says another process holds the file', async () => {
    const file = path.join(dir, 'control.properties');
    const real = (await import('node:fs/promises')).rename;
    const rename = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EPERM' }))
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
      .mockImplementation(real);
    const sleep = vi.fn(async () => undefined);
    await writeWhole(file, 'text', { rename, sleep });
    expect(rename).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[50], [100]]);
    expect(await readFile(file, 'utf8')).toBe('text');
  });

  it('gives up after five tries, or at once for other errors, and leaves no temporary file', async () => {
    const file = path.join(dir, 'control.properties');
    const busy = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { code: 'EACCES' }));
    await expect(writeWhole(file, 'x', { rename: busy, sleep: async () => undefined })).rejects.toThrow(
      'busy',
    );
    expect(busy).toHaveBeenCalledTimes(5);
    const gone = vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    await expect(writeWhole(file, 'x', { rename: gone, sleep: async () => undefined })).rejects.toThrow(
      'gone',
    );
    expect(gone).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'makes the folders this user’s alone, even ones that were open',
    async () => {
      const agentDir = path.join(dir, 'java-agent');
      await mkdir(path.join(agentDir, 'status'), { recursive: true });
      await chmod(path.join(agentDir, 'status'), 0o777);
      await makeAgentFolder(agentDir);
      for (const folder of ['', 'jars', 'status']) {
        expect((await stat(path.join(agentDir, folder))).mode & 0o777).toBe(0o700);
      }
    },
  );

  it('installs the stub once and each agent build under its own name', async () => {
    const agentDir = path.join(dir, 'java-agent');
    const stub = path.join(dir, 'stub.jar');
    const impl = path.join(dir, 'impl.jar');
    await writeFile(stub, 'stub-1');
    await writeFile(impl, 'impl-1');
    const first = await installAgentJars(agentDir, { stub, impl, version: '0.1.30' });
    expect(first).toMatch(/^jars\/wirescry-agent-impl-0\.1\.30-[0-9a-f]{8}\.jar$/);
    expect(await readFile(path.join(agentDir, first), 'utf8')).toBe('impl-1');
    await writeFile(impl, 'impl-2');
    await writeFile(stub, 'stub-2');
    const second = await installAgentJars(agentDir, { stub, impl, version: '0.1.30' });
    expect(second).not.toBe(first);
    // The first build's copy stays: a running JVM may have it open.
    expect((await readdir(path.join(agentDir, 'jars'))).sort()).toEqual(
      [first, second].map((n) => n.slice('jars/'.length)).sort(),
    );
    expect(await readFile(path.join(agentDir, 'wirescry-agent.jar'), 'utf8')).toBe('stub-2');
    expect(await installAgentJars(agentDir, { stub, impl, version: '0.1.30' })).toBe(second);
    await expect(installAgentJars(agentDir, { stub, impl, version: '1/../x' })).rejects.toThrow(
      'Bad version',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'makes the jars this user’s alone again when their bytes match',
    async () => {
      const agentDir = path.join(dir, 'java-agent');
      const stub = path.join(dir, 'stub.jar');
      const impl = path.join(dir, 'impl.jar');
      await writeFile(stub, 'stub-1');
      await writeFile(impl, 'impl-1');
      const name = await installAgentJars(agentDir, { stub, impl, version: '0.1.30' });
      await chmod(path.join(agentDir, name), 0o664);
      await chmod(path.join(agentDir, 'wirescry-agent.jar'), 0o646);
      await installAgentJars(agentDir, { stub, impl, version: '0.1.30' });
      expect((await stat(path.join(agentDir, name))).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(agentDir, 'wirescry-agent.jar'))).mode & 0o777).toBe(0o600);
    },
  );

  it('keeps the stub a running JVM holds open on Windows, but not when there is none', async () => {
    const agentDir = path.join(dir, 'java-agent');
    const stub = path.join(dir, 'stub.jar');
    const impl = path.join(dir, 'impl.jar');
    await writeFile(stub, 'stub-1');
    await writeFile(impl, 'impl-1');
    await installAgentJars(agentDir, { stub, impl, version: '0.1.30' });
    await writeFile(stub, 'stub-2');
    const busy = {
      rename: vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' })),
      sleep: async () => undefined,
    };
    expect(await installAgentJars(agentDir, { stub, impl, version: '0.1.30' }, busy)).toMatch(/^jars\//);
    expect(await readFile(path.join(agentDir, 'wirescry-agent.jar'), 'utf8')).toBe('stub-1');
    await rm(path.join(agentDir, 'wirescry-agent.jar'));
    await expect(installAgentJars(agentDir, { stub, impl, version: '0.1.30' }, busy)).rejects.toThrow('busy');
    const denied = {
      rename: vi.fn().mockRejectedValue(Object.assign(new Error('read-only'), { code: 'EROFS' })),
      sleep: async () => undefined,
    };
    await writeFile(path.join(agentDir, 'wirescry-agent.jar'), 'stub-1');
    await expect(installAgentJars(agentDir, { stub, impl, version: '0.1.30' }, denied)).rejects.toThrow(
      'read-only',
    );
  });

  it('reads status files whose names agree with what they say', async () => {
    const agentDir = path.join(dir, 'java-agent');
    await makeAgentFolder(agentDir);
    const folder = path.join(agentDir, 'status');
    await writeFile(path.join(folder, '4242-a1.properties'), status());
    await writeFile(path.join(folder, '4243-a1.properties'), status()); // says pid 4242
    await writeFile(path.join(folder, '4242-a2.properties'), status()); // says id a1
    await writeFile(path.join(folder, '4244-b.properties'), 'junk');
    await writeFile(path.join(folder, '4245-c.tmp'), status({ pid: '4245', id: 'c' }));
    expect((await readStatuses(agentDir)).map((s) => `${s.pid}-${s.id}`)).toEqual(['4242-a1']);
    expect(await readStatuses(path.join(dir, 'nowhere'))).toEqual([]);
  });
});

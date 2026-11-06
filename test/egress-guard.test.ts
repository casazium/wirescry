/**
 * The egress guard on its own: what it lets through, what it refuses, and that it connects only
 * to addresses it checked. Fake DNS maps names to addresses; a fake connect maps the public
 * addresses used here (documentation ranges) to a local echo server.
 */
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  GUARD_HEADER,
  startEgressGuard,
  type EgressGuard,
  type EgressGuardOptions,
} from '../src/backend/egress-guard';

const PUBLIC = '203.0.113.5';
const PUBLIC_V6 = '2001:db8::99';

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
  socket: net.Socket;
}

/** Sends a raw request to the guard and reads its reply head (and body, if it ends). */
function send(guard: EgressGuard, request: string): Promise<Reply> {
  const { port } = new URL(guard.url);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
    let data = Buffer.alloc(0);
    let done = false;
    const finish = () => {
      if (done) return;
      const end = data.indexOf('\r\n\r\n');
      if (end === -1) return;
      const [statusLine, ...lines] = data.subarray(0, end).toString().split('\r\n');
      const headers = Object.fromEntries(
        lines.map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]),
      );
      const status = Number(statusLine!.split(' ')[1]);
      const body = data.subarray(end + 4).toString();
      // A tunnel stays open; an error reply has a body and closes.
      if (status !== 200 && body.length < Number(headers['content-length'] ?? 0)) return;
      done = true;
      socket.removeAllListeners('data');
      resolve({ status, headers, body, socket });
    };
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      finish();
    });
    socket.on('error', reject);
    socket.on('close', () => (done ? undefined : reject(new Error(`closed: ${data.toString()}`))));
    socket.write(request);
  });
}

const connectTo = (guard: EgressGuard, target: string) =>
  send(guard, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);

/** Writes through an open tunnel and reads the echo back. */
function echo(socket: net.Socket, text: string): Promise<string> {
  return new Promise((resolve) => {
    socket.once('data', (chunk: Buffer) => resolve(chunk.toString()));
    socket.write(text);
  });
}

describe('Egress guard', () => {
  let echoServer: net.Server;
  let echoPort: number;
  let guard: EgressGuard | undefined;
  let dns: Record<string, string[] | Error>;
  let lookups: string[];
  let connects: Array<[string, number]>;
  let allowLocal: boolean;
  let own: string[];

  beforeAll(async () => {
    echoServer = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', resolve));
    echoPort = (echoServer.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => echoServer.close(resolve));
  });
  afterEach(async () => {
    await guard?.stop();
    guard = undefined;
  });

  /** A guard with fake DNS, where the public test addresses lead to the echo server. */
  async function start(overrides: Partial<EgressGuardOptions> = {}): Promise<EgressGuard> {
    dns = {};
    lookups = [];
    connects = [];
    allowLocal = false;
    own = ['192.0.2.77'];
    guard = await startEgressGuard({
      allowLocal: () => allowLocal,
      lookup: async (host) => {
        lookups.push(host);
        const answer = dns[host];
        if (answer instanceof Error) throw answer;
        if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
        return answer;
      },
      connect: (address, port) => {
        connects.push([address, port]);
        // Documentation addresses stand in for the internet.
        const local = /^(203\.0\.113\.|198\.51\.100\.|2001:db8:)/.test(address) ? '127.0.0.1' : address;
        return net.connect({ host: local, port: port === 443 ? echoPort : port });
      },
      ownAddresses: () => own,
      ...overrides,
    });
    return guard;
  }

  describe('lets through', () => {
    it('a name that resolves to a public address, connecting to that address', async () => {
      const g = await start();
      dns['api.example'] = [PUBLIC];
      const reply = await connectTo(g, 'api.example:443');
      expect(reply.status).toBe(200);
      expect(await echo(reply.socket, 'hello')).toBe('hello');
      expect(connects).toEqual([[PUBLIC, 443]]);
      reply.socket.destroy();
    });

    it('public IP literals, IPv4 and IPv6, without a lookup', async () => {
      const g = await start();
      for (const target of [`${PUBLIC}:443`, `[${PUBLIC_V6}]:443`]) {
        const reply = await connectTo(g, target);
        expect(reply.status).toBe(200);
        reply.socket.destroy();
      }
      expect(lookups).toEqual([]);
    });

    it('bytes the client sent along with the CONNECT', async () => {
      const g = await start();
      dns['api.example'] = [PUBLIC];
      const reply = await send(g, 'CONNECT api.example:443 HTTP/1.1\r\nHost: api.example:443\r\n\r\nearly');
      expect(reply.status).toBe(200);
      const echoed = await new Promise<string>((resolve) =>
        reply.socket.once('data', (c: Buffer) => resolve(c.toString())),
      );
      expect(echoed).toBe('early');
      reply.socket.destroy();
    });

    it('anything, local included, while the device may reach this computer', async () => {
      const g = await start();
      allowLocal = true;
      const reply = await connectTo(g, `127.0.0.1:${echoPort}`);
      expect(reply.status).toBe(200);
      expect(await echo(reply.socket, 'local')).toBe('local');
      reply.socket.destroy();
    });

    it('the next address when the first one refuses the connection', async () => {
      const g = await start({
        connect: (address, port) => {
          connects.push([address, port]);
          // The first address has nothing listening; the second is the echo server.
          return net.connect({ host: '127.0.0.1', port: address === PUBLIC ? 1 : echoPort });
        },
      });
      dns['api.example'] = [PUBLIC, '203.0.113.6'];
      const reply = await connectTo(g, 'api.example:443');
      expect(reply.status).toBe(200);
      expect(connects.map(([a]) => a)).toEqual([PUBLIC, '203.0.113.6']);
      reply.socket.destroy();
    });
  });

  describe('refuses', () => {
    it.each([
      ['127.0.0.1:80', '127.0.0.1', 'this-computer'],
      ['[::1]:80', '::1', 'this-computer'],
      ['[::ffff:127.0.0.1]:80', '::ffff:127.0.0.1', 'this-computer'],
      ['0.0.0.0:80', '0.0.0.0', 'this-computer'],
      ['169.254.169.254:80', '169.254.169.254', 'link-local'],
      ['10.1.2.3:443', '10.1.2.3', 'local-network'],
      ['[64:ff9b::7f00:1]:80', '64:ff9b::7f00:1', 'this-computer'],
      ['192.0.2.77:443', '192.0.2.77', 'this-computer'],
    ])('the IP literal %s, without connecting', async (target, address, kind) => {
      const g = await start();
      const reply = await connectTo(g, target);
      expect(reply.status).toBe(403);
      // The device isn't told the address; Wirescry is.
      expect(reply.body).not.toContain(address);
      expect(g.verdict(reply.headers[GUARD_HEADER])).toEqual({
        refused: expect.objectContaining({ kind, address }),
      });
      expect(connects).toEqual([]);
    });

    it('a name that resolves to a local address', async () => {
      const g = await start();
      dns['dev.internal'] = ['192.168.1.20'];
      const reply = await connectTo(g, 'dev.internal:8080');
      expect(reply.status).toBe(403);
      expect(reply.body).not.toContain('192.168.1.20');
      expect(reply.body).toContain("devices can't reach this computer or its local networks");
      expect(g.verdict(reply.headers[GUARD_HEADER])).toEqual({
        refused: {
          kind: 'local-network',
          description: 'a private network address',
          host: 'dev.internal',
          address: '192.168.1.20',
        },
      });
      expect(connects).toEqual([]);
    });

    it('localhost by name', async () => {
      const g = await start({ lookup: undefined });
      const reply = await connectTo(g, `localhost:${echoPort}`);
      expect(reply.status).toBe(403);
    });

    it.each(['2130706433', '127.1', '0x7f.1', 'localhost.', 'LOCALHOST'])(
      'the name %j, which the system resolver turns into this computer',
      async (name) => {
        const g = await start({ lookup: undefined });
        const reply = await connectTo(g, `${name}:${echoPort}`);
        expect(reply.status).toBe(403);
        expect(connects).toEqual([]);
      },
    );

    it('a connection that came up after the device lost access while it was connecting', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const g = await start({
        connect: (address, port) => {
          connects.push([address, port]);
          const socket = new net.Socket();
          void held.then(() => socket.connect({ host: '127.0.0.1', port: echoPort }));
          return socket;
        },
      });
      allowLocal = true;
      const replying = connectTo(g, `127.0.0.1:${echoPort}`);
      await expect.poll(() => connects.length).toBe(1);
      allowLocal = false;
      g.recheck();
      release();
      const reply = await replying;
      expect(reply.status).toBe(403);
      expect(g.verdict(reply.headers[GUARD_HEADER])).toMatchObject({ refused: { address: '127.0.0.1' } });
    });

    it('a name with a local address among public ones', async () => {
      const g = await start();
      dns['mixed.example'] = [PUBLIC, '10.0.0.5'];
      const reply = await connectTo(g, 'mixed.example:443');
      expect(reply.status).toBe(403);
      expect(connects).toEqual([]);
    });

    it("this computer's addresses as they are now, not as they were", async () => {
      const g = await start();
      dns['me.example'] = ['198.51.100.9'];
      own = ['198.51.100.9'];
      expect((await connectTo(g, 'me.example:443')).status).toBe(403);
      own = [];
      const reply = await connectTo(g, 'me.example:443');
      expect(reply.status).toBe(200);
      reply.socket.destroy();
    });

    it('local addresses again once the device may no longer reach this computer', async () => {
      const g = await start();
      allowLocal = true;
      const allowed = await connectTo(g, `127.0.0.1:${echoPort}`);
      expect(allowed.status).toBe(200);
      allowed.socket.destroy();
      allowLocal = false;
      expect((await connectTo(g, `127.0.0.1:${echoPort}`)).status).toBe(403);
    });
  });

  it("can't be fooled by DNS rebinding: it connects to the address it checked", async () => {
    const g = await start();
    let answers = 0;
    dns = new Proxy(
      {},
      {
        get: (_t, host) =>
          host === 'rebind.example' ? (answers++ === 0 ? [PUBLIC] : ['127.0.0.1']) : undefined,
      },
    );
    const reply = await connectTo(g, 'rebind.example:443');
    expect(reply.status).toBe(200);
    expect(answers).toBe(1);
    expect(connects).toEqual([[PUBLIC, 443]]);
    reply.socket.destroy();
  });

  describe('reports', () => {
    it('a failed lookup, with its code', async () => {
      const g = await start();
      const reply = await connectTo(g, 'nowhere.example:443');
      expect(reply.status).toBe(502);
      expect(g.verdict(reply.headers[GUARD_HEADER])).toEqual({
        error: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND nowhere.example' },
      });
    });

    it('a lookup with no addresses as not found', async () => {
      const g = await start();
      dns['empty.example'] = [];
      const reply = await connectTo(g, 'empty.example:443');
      expect(g.verdict(reply.headers[GUARD_HEADER])).toMatchObject({ error: { code: 'ENOTFOUND' } });
    });

    it('a refused connection, with its code', async () => {
      const g = await start();
      allowLocal = true;
      const reply = await connectTo(g, '127.0.0.1:1');
      expect(reply.status).toBe(502);
      expect(g.verdict(reply.headers[GUARD_HEADER])).toMatchObject({ error: { code: 'ECONNREFUSED' } });
    });

    it('each verdict once, and nothing for an id it never gave', async () => {
      const g = await start();
      const reply = await connectTo(g, '127.0.0.1:80');
      const id = reply.headers[GUARD_HEADER];
      expect(g.verdict(id)).toBeDefined();
      expect(g.verdict(id)).toBeUndefined();
      expect(g.verdict('made-up')).toBeUndefined();
      expect(g.verdict(undefined)).toBeUndefined();
      const other = await startEgressGuard({ allowLocal: () => false });
      try {
        const again = await connectTo(g, '127.0.0.1:80');
        expect(other.verdict(again.headers[GUARD_HEADER])).toBeUndefined();
      } finally {
        await other.stop();
      }
    });
  });

  describe('rejects', () => {
    it('anything but CONNECT, forwarding nothing', async () => {
      const g = await start();
      dns['api.example'] = [PUBLIC];
      const reply = await send(g, 'GET http://api.example/ HTTP/1.1\r\nHost: api.example\r\n\r\n');
      expect(reply.status).toBe(405);
      expect(lookups).toEqual([]);
      expect(connects).toEqual([]);
    });

    it.each([
      'api.example',
      'api.example:0',
      'api.example:65536',
      '[api.example]:443',
      '[::1:443',
      ':443',
      'a:b:443',
    ])('the malformed target %j', async (target) => {
      const g = await start();
      const reply = await connectTo(g, target);
      expect(reply.status).toBe(400);
      expect(connects).toEqual([]);
    });
  });

  it('listens on loopback only, and closes open tunnels when stopped', async () => {
    const g = await start();
    expect(new URL(g.url).hostname).toBe('127.0.0.1');
    dns['api.example'] = [PUBLIC];
    const reply = await connectTo(g, 'api.example:443');
    const closed = new Promise((resolve) => reply.socket.once('close', resolve));
    await g.stop();
    guard = undefined;
    await closed;
  });

  it('closes its side when the client goes away during the lookup', async () => {
    let answer!: (addresses: string[]) => void;
    const g = await start({ lookup: () => new Promise((resolve) => (answer = resolve)) });
    const { port } = new URL(g.url);
    const client = net.connect({ host: '127.0.0.1', port: Number(port) });
    client.on('error', () => undefined);
    const closed = new Promise((resolve) => client.once('close', resolve));
    client.write('CONNECT slow.example:443 HTTP/1.1\r\nHost: slow.example:443\r\n\r\n');
    await expect.poll(() => answer).toBeDefined();
    // Half-close, as a client giving up does; the guard must not keep its end open.
    client.end();
    await closed;
    answer([PUBLIC]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connects).toEqual([]);
  });

  it('drops the upstream connection when the client goes away while connecting', async () => {
    let upstream: net.Socket | undefined;
    // A connect that never completes.
    const g = await start({
      connect: () => {
        upstream = new net.Socket();
        return upstream;
      },
    });
    dns['slow.example'] = [PUBLIC];
    const { port } = new URL(g.url);
    const client = net.connect({ host: '127.0.0.1', port: Number(port) });
    client.write('CONNECT slow.example:443 HTTP/1.1\r\nHost: slow.example:443\r\n\r\n');
    await expect.poll(() => upstream).toBeDefined();
    client.destroy();
    await expect.poll(() => upstream!.destroyed).toBe(true);
  });
});

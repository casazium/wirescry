import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { ownAddresses, refusedAddress, type Refusal } from './destinations';

/**
 * The egress guard: a small CONNECT proxy on this computer's loopback that a device listener
 * sends all its upstream traffic through (HTTP, HTTPS and WebSockets). It resolves each name
 * itself, checks every address it gets, and connects only to an address it checked, so DNS
 * rebinding can't get round it. Mockttp has no hook after its own DNS lookup, hence the proxy.
 *
 * A refused or failed CONNECT is answered with an HTTP error, which Mockttp's proxy agent hands
 * back as the upstream response. That response carries a one-time id in GUARD_HEADER; `verdict`
 * turns it back into what happened, so a real server can't fake one.
 */

export const GUARD_HEADER = 'x-wirescry-guard';

export type GuardVerdict =
  { refused: Refusal & { host: string; address: string } } | { error: { code: string; message: string } };

export interface EgressGuardOptions {
  /** Whether the device may reach this computer and its local networks. Read on each connection. */
  allowLocal(): boolean;
  /** Resolves a host name to addresses. Defaults to the system resolver. For tests. */
  lookup?: (host: string) => Promise<string[]>;
  /** Opens a TCP connection to a checked address. For tests. */
  connect?: (address: string, port: number) => net.Socket;
  /** This computer's own addresses. Read on each check. For tests. */
  ownAddresses?: () => string[];
}

export interface EgressGuard {
  /** The proxy URL to give Mockttp, e.g. http://127.0.0.1:1234. */
  url: string;
  /** What happened to the request whose response carried this GUARD_HEADER value, once. */
  verdict(id: string | undefined): GuardVerdict | undefined;
  /**
   * Closes open tunnels to addresses that are refused now, e.g. once the device may no longer
   * reach this computer: connections already open would otherwise keep being reused.
   */
  recheck(): void;
  stop(): Promise<void>;
}

/** How long a verdict waits to be read before it's forgotten. */
const VERDICT_LIFETIME_MS = 60_000;

const systemLookup = async (host: string): Promise<string[]> =>
  (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** host and port from a CONNECT target ("example.com:443" or "[::1]:80"), if it's well formed. */
function parseTarget(target: string | undefined): { host: string; port: number } | undefined {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(target ?? '');
  if (!match) return undefined;
  const host = match[1] ?? match[2]!;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return undefined;
  if (match[1] !== undefined && !net.isIPv6(host)) return undefined;
  return { host, port };
}

export async function startEgressGuard(options: EgressGuardOptions): Promise<EgressGuard> {
  const lookup = options.lookup ?? systemLookup;
  const connect = options.connect ?? ((address, port) => net.connect({ host: address, port }));
  const own = options.ownAddresses ?? ownAddresses;
  const verdicts = new Map<string, GuardVerdict>();
  const sockets = new Set<Duplex>();
  const tunnels = new Set<{ address: string; client: Duplex; upstream: net.Socket }>();

  const track = (socket: Duplex): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };

  /** Answers the CONNECT with an error, in one write: the agent only keeps the first chunk. */
  const answer = (
    client: Duplex,
    status: number,
    reason: string,
    message: string,
    verdict?: GuardVerdict,
  ) => {
    const body = Buffer.from(`${message}\n`);
    const head = [`HTTP/1.1 ${status} ${reason}`, 'Content-Type: text/plain; charset=utf-8'];
    head.push(`Content-Length: ${body.length}`, 'Connection: close');
    if (verdict) {
      const id = randomUUID();
      verdicts.set(id, verdict);
      setTimeout(() => verdicts.delete(id), VERDICT_LIFETIME_MS).unref();
      head.push(`${GUARD_HEADER}: ${id}`);
    }
    client.end(Buffer.concat([Buffer.from(`${head.join('\r\n')}\r\n\r\n`), body]));
  };

  const handle = async (target: string | undefined, client: Duplex, early: Buffer): Promise<void> => {
    // Until the tunnel is up, keep what the client sends, and notice if it goes away (the
    // socket is half-open, so a hang-up is only an 'end').
    let gone = false;
    let connecting: net.Socket | undefined;
    const pending: Buffer[] = early.length ? [early] : [];
    const keep = (chunk: Buffer) => pending.push(chunk);
    const leave = () => {
      gone = true;
      connecting?.destroy();
      client.destroy();
    };
    client.on('data', keep);
    client.once('end', leave);
    client.once('close', leave);
    const stopWatching = () => {
      client.off('data', keep);
      client.off('end', leave);
      client.off('close', leave);
    };

    const parsed = parseTarget(target);
    if (!parsed) {
      answer(client, 400, 'Bad Request', 'Wirescry: not a host and port.');
      return;
    }
    const { host, port } = parsed;
    let addresses: string[];
    try {
      addresses = net.isIP(host) ? [host] : await lookup(host);
      if (addresses.length === 0)
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'ENOTFOUND';
      const message = (error as Error).message ?? code;
      answer(client, 502, 'Bad Gateway', `Wirescry couldn't look up ${host}: ${message}`, {
        error: { code, message },
      });
      return;
    }
    if (gone) return;
    // Every address must be allowed, or none is used: a name can't mix in a private address.
    if (!options.allowLocal()) {
      const ownNow = own();
      for (const address of addresses) {
        const refusal = refusedAddress(address, ownNow);
        if (refusal) {
          answer(
            client,
            403,
            'Forbidden',
            // The device isn't told the address: it would map the computer's networks.
            `Wirescry blocked this request: devices can't reach this computer or its local networks unless allowed in Wirescry.`,
            { refused: { ...refusal, host, address } },
          );
          return;
        }
      }
    }
    let lastError: NodeJS.ErrnoException | undefined;
    for (const address of addresses) {
      if (gone) return;
      const upstream = connect(address, port);
      connecting = upstream;
      track(upstream);
      const connected = await new Promise<boolean>((resolve) => {
        upstream.once('connect', () => resolve(true));
        upstream.once('error', (error) => {
          lastError = error;
          resolve(false);
        });
        upstream.once('close', () => resolve(false));
      });
      connecting = undefined;
      if (!connected || gone) {
        upstream.destroy();
        continue;
      }
      // The switch may have gone off while connecting.
      const refusedNow = !options.allowLocal() ? refusedAddress(address, own()) : undefined;
      if (refusedNow) {
        upstream.destroy();
        stopWatching();
        answer(
          client,
          403,
          'Forbidden',
          `Wirescry blocked this request: devices can't reach this computer or its local networks unless allowed in Wirescry.`,
          { refused: { ...refusedNow, host, address } },
        );
        return;
      }
      stopWatching();
      const tunnel = { address, client, upstream };
      tunnels.add(tunnel);
      upstream.once('close', () => tunnels.delete(tunnel));
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.once('close', () => upstream.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      for (const chunk of pending) upstream.write(chunk);
      upstream.pipe(client);
      client.pipe(upstream);
      return;
    }
    if (gone) return;
    const code = lastError?.code ?? 'ECONNREFUSED';
    const message = lastError?.message ?? code;
    answer(client, 502, 'Bad Gateway', `Wirescry couldn't connect to ${host}: ${message}`, {
      error: { code, message },
    });
  };

  const server = http.createServer((_req, res) => {
    res.writeHead(405, { 'content-type': 'text/plain', connection: 'close' });
    res.end('Wirescry: this proxy only takes CONNECT.\n');
  });
  server.on('connection', (socket) => track(socket));
  server.on('connect', (req: http.IncomingMessage, client: Duplex, early: Buffer) => {
    client.on('error', () => undefined);
    handle(req.url, client, early).catch((error: unknown) => {
      console.error('[wirescry] egress guard failed:', error);
      client.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    verdict(id) {
      if (!id) return undefined;
      const verdict = verdicts.get(id);
      verdicts.delete(id);
      return verdict;
    },
    recheck() {
      if (options.allowLocal()) return;
      const ownNow = own();
      for (const tunnel of tunnels) {
        if (!refusedAddress(tunnel.address, ownNow)) continue;
        tunnel.upstream.destroy();
        tunnel.client.destroy();
      }
    },
    stop: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

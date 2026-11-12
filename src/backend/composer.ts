import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { ComposerRequest, Header } from '../shared/api';

/** The largest body the composer sends, in UTF-8 bytes. Commands from the UI are capped at 1 MB. */
export const MAX_COMPOSER_BODY = 512 * 1024;
const MAX_COMPOSER_HEADERS = 200;
const MAX_URL_LENGTH = 16 * 1024;
/** Header names and values together, like Node's default maxHeaderSize. */
const MAX_HEADER_BYTES = 16 * 1024;
/** Methods the proxy's HTTP parser accepts; it drops a request with any other. */
const METHODS = new Set(http.METHODS.filter((m) => m !== 'CONNECT'));
/** How long the proxy has to see a sent request before the send counts as failed. */
const CLAIM_TIMEOUT_MS = 15_000;

/** Headers Wirescry sets itself, or that would break the request. */
const MANAGED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'upgrade',
  'te',
  'http2-settings',
]);

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Standard base64, padded. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A request checked and cleaned up, with its URL parsed and its body as bytes. */
export type ValidComposerRequest = ComposerRequest & { parsedUrl: URL; bodyBytes: Buffer };

/** Checks a request from the UI and returns it cleaned up. Throws with a message for the user. */
export function validateComposerRequest(input: unknown): ValidComposerRequest {
  const request = input as Partial<ComposerRequest> | null;
  if (!request || typeof request !== 'object') throw new Error('No request to send.');
  const method = typeof request.method === 'string' ? request.method.trim().toUpperCase() : '';
  if (!TOKEN.test(method) || method.length > 32) throw new Error('Enter a method, such as GET or POST.');
  if (method === 'CONNECT') throw new Error("The composer can't send CONNECT requests.");
  if (!METHODS.has(method)) throw new Error(`${method} isn't an HTTP method Wirescry can send.`);

  const rawUrl = typeof request.url === 'string' ? request.url.trim() : '';
  if (rawUrl.length > MAX_URL_LENGTH) throw new Error('That URL is too long.');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error('Enter a full URL, starting with http:// or https://.');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Enter a full URL, starting with http:// or https://.');
  }
  if (!parsedUrl.hostname) throw new Error('The URL needs a host.');
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('Put credentials in an Authorization header, not in the URL.');
  }
  if (request.grpc !== undefined && typeof request.grpc !== 'boolean') {
    throw new Error('Whether it’s a gRPC call must be true or false.');
  }
  const grpc = request.grpc === true;
  if (grpc && method !== 'POST') throw new Error('A gRPC call is sent as POST.');
  // Wirescry's proxy reaches a server over HTTP/2 only with TLS, and gRPC needs HTTP/2.
  if (grpc && parsedUrl.protocol !== 'https:') {
    throw new Error('Wirescry can send a gRPC call only to an https:// URL.');
  }

  if (!Array.isArray(request.headers)) throw new Error('Headers must be a list.');
  if (request.headers.length > MAX_COMPOSER_HEADERS) throw new Error('Too many headers.');
  const headers: Header[] = [];
  // The proxy's parser limits the request line and headers together.
  let headerBytes = method.length + parsedUrl.href.length + parsedUrl.host.length + 32;
  for (const header of request.headers as unknown[]) {
    if (!Array.isArray(header) || typeof header[0] !== 'string' || typeof header[1] !== 'string') {
      throw new Error('Each header needs a name and a value.');
    }
    const name = header[0].trim();
    const value = header[1].trim();
    if (!TOKEN.test(name)) throw new Error(`"${name.slice(0, 40)}" isn't a valid header name.`);
    // Header values are Latin-1 on the wire, with no line breaks.
    if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) {
      throw new Error(`The ${name} header can only use plain text, without emoji or line breaks.`);
    }
    if (MANAGED_HEADERS.has(name.toLowerCase())) continue;
    headerBytes += name.length + value.length + 4;
    if (headerBytes > MAX_HEADER_BYTES) {
      throw new Error(`The URL and headers can be at most ${MAX_HEADER_BYTES / 1024} KB together.`);
    }
    headers.push([name, value]);
  }

  const body = typeof request.body === 'string' ? request.body : '';
  const tooLarge = `The body can be at most ${MAX_COMPOSER_BODY / 1024} KB.`;
  let bodyBytes: Buffer;
  const { bodyBase64 } = request;
  if (bodyBase64 !== undefined) {
    if (typeof bodyBase64 !== 'string') throw new Error('The body’s bytes must be in base64.');
    // Checked before decoding, so an oversized body is never decoded.
    if (bodyBase64.length > Math.ceil(MAX_COMPOSER_BODY / 3) * 4) throw new Error(tooLarge);
    if (!BASE64.test(bodyBase64)) throw new Error('The body’s bytes aren’t valid base64.');
    bodyBytes = Buffer.from(bodyBase64, 'base64');
  } else {
    bodyBytes = Buffer.from(body);
  }
  if (bodyBytes.length > MAX_COMPOSER_BODY) throw new Error(tooLarge);
  // A fragment stays in the client; it's never sent.
  parsedUrl.hash = '';
  return {
    method,
    url: parsedUrl.href,
    headers,
    body,
    ...(bodyBase64 !== undefined ? { bodyBase64 } : {}),
    ...(grpc ? { grpc } : {}),
    parsedUrl,
    bodyBytes,
  };
}

interface Waiting {
  claim(exchangeId: string): void;
  fail(error: Error): void;
}

/**
 * Sends requests written in the composer through Wirescry's own proxy, so they're recorded
 * and rules apply like any other. Each goes on its own connection from 127.0.0.1; the proxy
 * asks `claim` about each new request, and the local port says which send it came from.
 */
export class Composer {
  private readonly waiting = new Map<number, Waiting>();
  private readonly active = new Map<string, () => void>();

  constructor(private readonly options: { proxyPort(): number; caCert(): string; claimTimeoutMs?: number }) {}

  /** Whether the request the proxy just received was sent from here. */
  claim(remotePort: number | undefined, remoteAddress: string | undefined, exchangeId: string): boolean {
    if (remotePort === undefined || !isLoopback(remoteAddress)) return false;
    const waiting = this.waiting.get(remotePort);
    if (!waiting) return false;
    this.waiting.delete(remotePort);
    waiting.claim(exchangeId);
    return true;
  }

  /** Sends it, resolving with the exchange id once the proxy has it. The response is recorded as usual. */
  async send(input: unknown): Promise<{ exchangeId: string }> {
    const { method, headers, parsedUrl, bodyBytes, grpc } = validateComposerRequest(input);
    const secure = parsedUrl.protocol === 'https:';
    const port = Number(parsedUrl.port) || (secure ? 443 : 80);
    const raw: string[] = [];
    for (const [name, value] of headers) raw.push(name, value);
    const sendsBody = bodyBytes.length > 0 || !['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE'].includes(method);
    raw.push('Host', parsedUrl.host);
    if (sendsBody) raw.push('Content-Length', String(bodyBytes.length));

    const socket = await connect(this.options.proxyPort());
    const localPort = socket.localPort;
    let destroy = (): void => {
      socket.destroy();
    };
    let settled = false;

    return new Promise<{ exchangeId: string }>((resolve, reject) => {
      const fail = (error: Error): void => {
        if (localPort !== undefined) this.waiting.delete(localPort);
        clearTimeout(timer);
        destroy();
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      const timer = setTimeout(
        () => fail(new Error("Wirescry's proxy didn't receive the request.")),
        this.options.claimTimeoutMs ?? CLAIM_TIMEOUT_MS,
      );
      timer.unref?.();
      if (localPort === undefined) {
        fail(new Error("Couldn't connect to Wirescry's proxy."));
        return;
      }
      let claimedId: string | undefined;
      this.waiting.set(localPort, {
        fail,
        claim: (exchangeId) => {
          clearTimeout(timer);
          claimedId = exchangeId;
          this.active.set(exchangeId, () => destroy());
          settled = true;
          resolve({ exchangeId });
        },
      });
      const done = (): void => {
        if (claimedId) this.active.delete(claimedId);
        destroy();
      };

      const issue = (create: () => net.Socket, path: string, client: typeof http | typeof https): void => {
        const req = client.request(
          {
            method,
            path,
            headers: raw as unknown as http.OutgoingHttpHeaders,
            createConnection: create,
            setHost: false,
          },
          (res) => {
            // A response before the proxy recorded the request: the proxy itself refused it.
            if (!settled) {
              res.resume();
              fail(new Error(`Wirescry's proxy refused the request (${res.statusCode ?? 'no status'}).`));
              return;
            }
            // The proxy records the response; this side only has to read it.
            res.resume();
            res.on('end', done);
            res.on('error', done);
            res.on('close', done);
          },
        );
        req.on('error', (error) => {
          if (settled) done();
          else fail(new Error(`Couldn't send the request: ${error.message}`));
        });
        req.end(sendsBody ? bodyBytes : undefined);
      };

      /** A gRPC call: one HTTP/2 stream on its own session, over the TLS tunnel to the proxy. */
      const issueHttp2 = (secureSocket: tls.TLSSocket): void => {
        if (secureSocket.alpnProtocol !== 'h2') {
          fail(new Error("Wirescry's proxy didn't agree to HTTP/2."));
          return;
        }
        const session = http2.connect(`https://${parsedUrl.host}`, { createConnection: () => secureSocket });
        let stream: http2.ClientHttp2Stream | undefined;
        const teardown = (): void => {
          session.destroy();
          secureSocket.destroy();
          socket.destroy();
        };
        destroy = () => {
          // RST_STREAM with CANCEL tells the proxy the client gave up. It's sent before the
          // connection closes (else it may never leave). A stream that ended normally is already
          // closed, so a finished call isn't marked as cancelled.
          if (!stream || stream.closed || stream.destroyed) {
            teardown();
            return;
          }
          // Closing the session gracefully lets the frame go out first, before the socket ends
          // (destroying it at once loses the frame on Windows). A peer that never lets go is
          // dropped after a second.
          const flushed = setTimeout(teardown, 1000);
          flushed.unref?.();
          stream.close(http2.constants.NGHTTP2_CANCEL);
          session.close(() => {
            clearTimeout(flushed);
            teardown();
          });
        };
        session.on('error', (error) => {
          if (settled) done();
          else fail(new Error(`Couldn't send the request: ${error.message}`));
        });
        // HTTP/2 header names are lowercase; a name given more than once is sent once per value.
        // No prototype, so names such as `constructor` or `__proto__` are ordinary headers.
        const fields: http2.OutgoingHttpHeaders = Object.assign(Object.create(null) as object, {
          ':method': method,
          ':scheme': 'https',
          ':authority': parsedUrl.host,
          ':path': `${parsedUrl.pathname}${parsedUrl.search}`,
        });
        for (const [name, value] of headers) {
          const key = name.toLowerCase();
          const had = fields[key];
          fields[key] = had === undefined ? value : [...(Array.isArray(had) ? had : [String(had)]), value];
        }
        // gRPC servers need it, to know the client reads trailers.
        fields.te = 'trailers';
        try {
          stream = session.request(fields);
        } catch (error) {
          // Node refuses some headers given twice, such as Content-Type.
          fail(new Error(`Couldn't send the request: ${(error as Error).message}`));
          return;
        }
        stream.on('response', (head) => {
          // A response before the proxy recorded the request: the proxy itself refused it.
          if (!settled)
            fail(new Error(`Wirescry's proxy refused the request (${head[':status'] ?? 'no status'}).`));
        });
        // The proxy records the response and its trailers; this side only has to read it. Once the
        // stream has closed (after its trailers), its session is closed too.
        stream.resume();
        stream.on('error', (error) => {
          if (settled) done();
          else fail(new Error(`Couldn't send the request: ${error.message}`));
        });
        stream.on('close', () => {
          if (settled) done();
          else fail(new Error("Wirescry's proxy closed the stream without recording the request."));
        });
        stream.end(bodyBytes);
      };

      socket.on('error', (error) => {
        if (!settled) fail(new Error(`Couldn't send the request: ${error.message}`));
      });
      socket.on('close', () => {
        if (!settled)
          fail(new Error("Wirescry's proxy closed the connection without recording the request."));
      });

      if (!secure) {
        issue(() => socket, parsedUrl.href, http);
        return;
      }
      // HTTPS: open a tunnel, then speak TLS to the proxy, which presents Wirescry's certificate.
      // `hostname` keeps an IPv6 address's brackets, as CONNECT needs.
      const authority = `${parsedUrl.hostname}:${port}`;
      const connectReq = http.request({
        method: 'CONNECT',
        path: authority,
        headers: { Host: authority },
        createConnection: () => socket,
      });
      connectReq.on('connect', (res, tunnel) => {
        if (res.statusCode !== 200) {
          fail(new Error(`Wirescry's proxy refused the tunnel (${res.statusCode}).`));
          return;
        }
        const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
        const secureSocket = tls.connect({
          socket: tunnel,
          ...(net.isIP(hostname) ? {} : { servername: hostname }),
          ca: this.options.caCert(),
          // This hop only reaches Wirescry's own proxy, whose certificate is pinned by `ca`.
          checkServerIdentity: () => undefined,
          // The proxy talks HTTP/2 to the server only when the client does.
          ALPNProtocols: grpc ? ['h2'] : ['http/1.1'],
        });
        destroy = () => {
          secureSocket.destroy();
          socket.destroy();
        };
        secureSocket.on('error', (error) => {
          if (!settled) fail(new Error(`Couldn't send the request: ${error.message}`));
        });
        if (grpc) secureSocket.once('secureConnect', () => issueHttp2(secureSocket));
        else issue(() => secureSocket, `${parsedUrl.pathname}${parsedUrl.search}`, https);
      });
      connectReq.on('error', (error) => {
        if (!settled) fail(new Error(`Couldn't send the request: ${error.message}`));
      });
      connectReq.end();
    });
  }

  /** Stops a request still waiting for its response. Returns whether there was one. */
  cancel(exchangeId: string): boolean {
    const destroy = this.active.get(exchangeId);
    if (!destroy) return false;
    this.active.delete(exchangeId);
    destroy();
    return true;
  }

  /** Stops everything, e.g. when the backend stops. */
  close(): void {
    for (const destroy of this.active.values()) destroy();
    this.active.clear();
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const send of waiting) send.fail(new Error('Wirescry stopped before the request was sent.'));
  }
}

/** Sends always come from 127.0.0.1 (see connect), so nothing else can claim one. */
function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
    socket.once('error', (error) =>
      reject(new Error(`Couldn't connect to Wirescry's proxy: ${error.message}`, { cause: error })),
    );
  });
}

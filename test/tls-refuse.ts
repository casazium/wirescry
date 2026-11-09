/**
 * HTTPS clients that refuse Wirescry's certificate the way real ones do: with a TLS alert as soon
 * as the proxy's certificate arrives, before any request. Node's own client checks certificates
 * only after the handshake, so it can't refuse like that.
 */
import http from 'node:http';
import type net from 'node:net';
import { Duplex } from 'node:stream';
import tls from 'node:tls';

/** A CONNECT tunnel through a proxy, to `authority`. */
export function tunnel(port: number, authority: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: authority });
    req.once('connect', (res, socket) =>
      res.statusCode === 200 ? resolve(socket) : reject(new Error(`CONNECT ${res.statusCode}`)),
    );
    req.once('error', reject);
    req.end();
  });
}

/** TLS alert record: fatal, unknown_ca (RFC 5246 §7.2), in the clear as TLS 1.2 handshakes send it. */
export const UNKNOWN_CA_ALERT = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x30]);

/**
 * Starts a TLS 1.2 handshake through a tunnel and, when the proxy's certificate arrives, does
 * `onServerHello` with the raw tunnel. Node's own client checks certificates only after the
 * handshake, so it can't refuse the way Android's does.
 */
export async function handshake(
  port: number,
  host: string,
  servername: string,
  onServerHello: (raw: net.Socket) => void,
): Promise<void> {
  const raw = await tunnel(port, `${host}:443`);
  await new Promise<void>((resolve) => {
    let answered = false;
    const relay = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        if (raw.writable) raw.write(chunk, () => done());
        else done();
      },
    });
    raw.on('data', (data: Buffer) => {
      if (!answered) {
        answered = true;
        onServerHello(raw);
      }
      relay.push(data);
    });
    raw.once('close', () => {
      relay.push(null);
      resolve();
    });
    raw.on('error', () => undefined);
    tls.connect({ socket: relay, servername, maxVersion: 'TLSv1.2' }).on('error', () => undefined);
  });
}

/** A fatal TLS 1.2 alert record, in the clear. */
export const alertRecord = (description: number): Buffer =>
  Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, description]);

/** Refuses the certificate with a TLS alert, as Android apps that ignore user certificates do (measured). */
export const refuse = (
  port: number,
  host: string,
  servername = host,
  alert: Buffer = UNKNOWN_CA_ALERT,
): Promise<void> => handshake(port, host, servername, (raw) => raw.end(alert));

/** Goes away mid-handshake without a word, as a client dropping a spare connection. */
export const drop = (port: number, host: string): Promise<void> =>
  handshake(port, host, host, (raw) => raw.destroy());

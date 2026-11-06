/**
 * A fake ADB server that replays bytes recorded from a real one (test/fixtures/adb, recorded
 * with scripts/adb-record.mjs). Each request a client sends is answered with what the real
 * server sent after the same request, in the same connection. Tests can also script answers.
 */
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { AdbEndpoint } from '../src/backend/android/adb-client';

interface Chunk {
  from: 'client' | 'server';
  base64?: string;
  end?: true;
}
interface Recording {
  connections: Array<{ chunks: Chunk[] }>;
}

/** What the real server sent after each request of a recorded connection. */
interface Exchange {
  /** The requests so far in the connection, this one last. */
  requests: string[];
  /** Server chunks until the next request, and whether the server then hung up. */
  reply: Buffer[];
  ends: boolean;
}

export function loadRecording(name: string): Recording {
  return JSON.parse(
    readFileSync(path.join(__dirname, 'fixtures', 'adb', `${name}.json`), 'utf8'),
  ) as Recording;
}

/** A length-prefixed request at the start of `data`, if it is one. */
function requestIn(data: Buffer): { request: string; rest: Buffer } | undefined {
  if (data.length < 4) return undefined;
  const head = data.subarray(0, 4).toString('latin1');
  if (!/^[0-9a-f]{4}$/i.test(head)) return undefined;
  const length = parseInt(head, 16);
  if (data.length < 4 + length) return undefined;
  return { request: data.subarray(4, 4 + length).toString('utf8'), rest: data.subarray(4 + length) };
}

function exchangesOf(recording: Recording): Exchange[] {
  const out: Exchange[] = [];
  for (const { chunks } of recording.connections) {
    const requests: string[] = [];
    let current: Exchange | undefined;
    // The server hanging up after the client did is the recording ending, not part of a reply.
    let clientEnded = false;
    for (const chunk of chunks) {
      if (chunk.from === 'client' && chunk.end) clientEnded = true;
      else if (chunk.from === 'client') {
        const parsed = chunk.base64 ? requestIn(Buffer.from(chunk.base64, 'base64')) : undefined;
        if (parsed) {
          requests.push(parsed.request);
          current = { requests: [...requests], reply: [], ends: false };
          out.push(current);
        }
      } else if (current) {
        if (chunk.end) current.ends = !clientEnded;
        else current.reply.push(Buffer.from(chunk.base64!, 'base64'));
      }
    }
  }
  return out;
}

export interface FakeAdb {
  endpoint: AdbEndpoint;
  /** Everything clients sent, per connection, in order. */
  received: Buffer[][];
  /** The requests clients sent, per connection. */
  requests: string[][];
  /** Ends every open connection, as a restarted server would. */
  dropAll(): void;
  close(): Promise<void>;
}

export interface FakeAdbOptions {
  /** Recordings to replay. */
  recordings?: Recording[];
  /** Send each reply one byte at a time, to test reading across splits. */
  byteByByte?: boolean;
  /**
   * Answers a request itself instead: return true if it did. Gets the connection's requests
   * so far (this one last).
   */
  script?: (requests: string[], socket: net.Socket) => boolean;
}

export async function startFakeAdb(options: FakeAdbOptions = {}): Promise<FakeAdb> {
  const exchanges = (options.recordings ?? []).flatMap(exchangesOf);
  const received: Buffer[][] = [];
  const requests: string[][] = [];
  const sockets = new Set<net.Socket>();

  const send = async (socket: net.Socket, reply: Buffer[], ends: boolean): Promise<void> => {
    for (const chunk of reply) {
      if (!options.byteByByte) socket.write(chunk);
      else {
        for (const byte of chunk) {
          if (socket.destroyed) return;
          socket.write(Buffer.from([byte]));
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }
    if (ends) socket.end();
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const mine: Buffer[] = [];
    const asked: string[] = [];
    received.push(mine);
    requests.push(asked);
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      mine.push(chunk);
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const parsed = requestIn(pending);
        // Not a request (e.g. a shell packet): kept in `received` for tests to check.
        if (!parsed) {
          if (pending.length >= 4 && !/^[0-9a-f]{4}$/i.test(pending.subarray(0, 4).toString('latin1'))) {
            pending = Buffer.alloc(0);
          }
          return;
        }
        pending = parsed.rest;
        asked.push(parsed.request);
        if (options.script?.([...asked], socket)) continue;
        const match = exchanges.find(
          (e) => e.requests.length === asked.length && e.requests.every((r, i) => r === asked[i]),
        );
        if (!match) {
          const message = Buffer.from(`fake adb: nothing recorded for ${asked.join(' then ')}`);
          socket.end(
            Buffer.concat([Buffer.from(`FAIL${message.length.toString(16).padStart(4, '0')}`), message]),
          );
          return;
        }
        void send(socket, match.reply, match.ends);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port },
    received,
    requests,
    dropAll() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

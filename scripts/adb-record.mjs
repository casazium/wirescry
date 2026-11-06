#!/usr/bin/env node
// Records the bytes between ADB clients and the real ADB server, for the fake server in
// test/adb-*.test.ts to replay. Listens on 127.0.0.1:<listen> and passes each connection on to
// the server on 127.0.0.1:5037, writing every chunk, both ways, to <out.json> when stopped
// (Ctrl-C). Point a client at it with ADB_SERVER_SOCKET=tcp:127.0.0.1:<listen>.
//
//   node scripts/adb-record.mjs 15037 test/fixtures/adb/name.json
//
// Recordings hold whatever the device says (serials, model names, property values): check
// them before committing.
import { writeFileSync } from 'node:fs';
import net from 'node:net';

const [listen = '15037', out] = process.argv.slice(2);
if (!out) {
  console.error('usage: adb-record.mjs <listen-port> <out.json>');
  process.exit(2);
}
const upstreamPort = Number(process.env.ADB_UPSTREAM_PORT ?? 5037);
const connections = [];
const start = Date.now();

const server = net.createServer((client) => {
  const record = { chunks: [] };
  connections.push(record);
  const upstream = net.connect({ host: '127.0.0.1', port: upstreamPort });
  const log = (from) => (data) =>
    record.chunks.push({
      from,
      at: Date.now() - start,
      base64: data.toString('base64'),
      text: printable(data),
    });
  client.on('data', log('client'));
  upstream.on('data', log('server'));
  client.on('end', () => record.chunks.push({ from: 'client', end: true }));
  upstream.on('end', () => record.chunks.push({ from: 'server', end: true }));
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
});

/** The chunk as text with non-printing bytes escaped, for reading the recording. */
function printable(data) {
  return [...data]
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`))
    .join('');
}

server.listen(Number(listen), '127.0.0.1', () =>
  console.error(`recording 127.0.0.1:${listen} -> ${upstreamPort}`),
);
process.on('SIGINT', () => {
  writeFileSync(
    out,
    JSON.stringify({ recordedAt: new Date(start).toISOString(), connections }, null, 2) + '\n',
  );
  console.error(`wrote ${connections.length} connections to ${out}`);
  process.exit(0);
});

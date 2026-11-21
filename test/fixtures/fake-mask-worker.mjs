// A stand-in for src/backend/mask-worker.mts, to test Masker (src/backend/masker.ts): what it does
// is set by each job's `own.mode`. Each worker started appends a line to the file in
// WIRESCRY_FAKE_WORKER_LOG, so a test can count them.
import { appendFileSync, readFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';

const logFile = process.env.WIRESCRY_FAKE_WORKER_LOG;
if (logFile) appendFileSync(logFile, 'started\n');
const workerNumber = logFile ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length : 1;
const taught = [];

parentPort.on('message', (message) => {
  const reply = (body) => parentPort.postMessage({ id: message.id, ...body });
  if (message.op === 'teach') {
    if (message.parts.some((part) => part.fail)) return reply({ ok: false, error: 'teach failed' });
    for (const part of message.parts) taught.push(part.name);
    return reply({ ok: true, taught: true });
  }
  const mode = message.own.mode;
  if (mode === 'crash') process.exit(3);
  if (mode === 'throw') throw new Error('thrown in the worker');
  if (mode === 'hang') return;
  if (mode === 'fail') return reply({ ok: false, error: 'it failed' });
  if (mode === 'out-of-turn') return reply({ ok: true, taught: true });
  const answer = () =>
    reply({
      ok: true,
      masked: {
        bytes: message.body.bytes,
        ranges: [],
        text: JSON.stringify({ taught, worker: workerNumber }),
      },
      full: false,
    });
  if (mode === 'slow') setTimeout(answer, 300);
  else answer();
});

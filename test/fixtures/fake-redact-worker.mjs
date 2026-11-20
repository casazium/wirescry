// A stand-in for src/backend/redact-worker.mts, to test HarRedactor (src/backend/redactor.ts):
// what it does is set by each entry's `mode`. Each worker started appends a line to the file in
// WIRESCRY_FAKE_WORKER_LOG, so a test can count them.
import { appendFileSync, readFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';

const logFile = process.env.WIRESCRY_FAKE_WORKER_LOG;
if (logFile) appendFileSync(logFile, 'started\n');
/** 1 for the first worker a test started, 2 for the next, … */
const workerNumber = logFile ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length : 1;
let collected = 0;
let redacted = 0;

parentPort.on('message', (message) => {
  const reply = (body) => parentPort.postMessage({ id: message.id, ...body });
  if (message.op === 'collect') {
    if (message.parts.some((part) => part.fail)) return reply({ ok: false, error: 'collect failed' });
    collected += message.parts.length;
    return reply({ ok: true, collected: true });
  }
  redacted += 1;
  const mode = message.entry.mode;
  // 'crash-first' crashes only the first worker: the retry, in a new one, works.
  if (mode === 'crash' || (mode === 'crash-first' && workerNumber === 1)) process.exit(3);
  if (mode === 'throw') throw new Error('thrown in the worker');
  if (mode === 'hang') return;
  if (mode === 'fail') return reply({ ok: false, error: 'it failed' });
  if (mode === 'too-large') return reply({ ok: true, tooLarge: true });
  if (mode === 'dropped') return reply({ ok: true, dropped: true, error: 'bad headers' });
  if (mode === 'out-of-turn') return reply({ ok: true, collected: true });
  reply({
    ok: true,
    text: JSON.stringify({ collected, redacted }),
    values: 1,
    notScanned: 0,
    leftOut: 0,
    full: false,
    ms: 1,
  });
});

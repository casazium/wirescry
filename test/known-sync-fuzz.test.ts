/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A randomized check of Hide Secrets' known values end to end: the backend's WindowKnown and
 * UpdateBatcher and the window's KnownSync over an ordered connection, through adds, responses,
 * evictions, full Clears, flushes, reconnects, switching on and off, and rebuilds. Written by the
 * design's reviewer; the Clear is told at once, as the backend now does.
 */
import { expect, it } from 'vitest';
import { WindowKnown } from '../src/backend/window-known';
import { UpdateBatcher } from '../src/backend/update-batcher';
import { KnownSync } from '../src/renderer/src/known-sync';
import { KnownValues } from '../src/shared/redact-body';
import { redactHeaders, redactUrl } from '../src/shared/redact';

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const drain = async () => {
  for (let i = 0; i < 30; i++) await null;
};
const immediate = () => new Promise<void>((r) => setImmediate(r));

const stats = { checked: 0, full: 0, rest: 0, epochs: 0 };
function valuesOf(d: any): string[] {
  const k = new KnownValues();
  try {
    redactUrl(d.summary.url, k);
  } catch {
    // A URL that can't be read teaches nothing.
  }
  for (const l of [d.requestHeaders, d.responseHeaders, d.requestTrailers, d.responseTrailers])
    if (l) redactHeaders(l, k);
  return k.list(0, Infinity);
}

async function run(seed: number, steps: number): Promise<string[]> {
  const rand = rng(seed);
  const pick = (n: number) => Math.floor(rand() * n);
  let n = 0;
  const shared = seed % 3 === 0;
  const tok = () =>
    shared
      ? `Sh4redRunQ7zSh4redRunQ7zSh4redRunQ7z.${(n++).toString(36)}k${n}`
      : `T${seed}x${(n++).toString(36)}${'q7Zk9mW2'.repeat(4)}${n}`;
  const store = new Map<string, any>();
  const problems: string[] = [];
  const log: string[] = [];
  // connection
  let conn:
    | {
        queue: any[];
        pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
        commands: any[];
        open: boolean;
      }
    | undefined;
  const broadcast = (m: any) => {
    if (conn?.open) conn.queue.push(m);
  };
  const batcher = new UpdateBatcher(
    (m) => broadcast({ ...m, details: m.exchanges.map((s: any) => store.get(s.id)) }),
    1e9,
    (changed) => {
      if (!wk.watching) return undefined;
      for (const s of changed) {
        const e = store.get(s.id);
        if (e) wk.collect(e);
      }
      return wk.take();
    },
  );
  const wk = new WindowKnown(
    { ids: () => [...store.keys()], get: (id) => store.get(id) },
    { flush: () => batcher.flush(), chunkMs: 0, rebuildAfter: 3, rebuildEveryMs: 0 },
  );
  const forget = (id: string) => {
    batcher.remove(id);
    wk.forget(id);
  };
  const handle = async (c: any): Promise<unknown> => {
    if (c.command === 'watchKnownValues') {
      const epoch = wk.watch(c.on);
      return epoch === undefined ? {} : { epoch };
    }
    if (c.command === 'getKnownValues') return wk.page(c.epoch, c.after);
    throw new Error('?');
  };
  // window
  const rows = new Map<string, any>();
  let masking: any;
  let on = false;
  const sync = new KnownSync((m) => (masking = m));
  let cid = 0;
  const connect = () => {
    const c = { queue: [] as any[], pending: new Map(), commands: [] as any[], open: true };
    conn = c;
    c.queue.push({ type: 'hello', details: [...store.values()] });
  };
  const disconnect = () => {
    if (!conn) return;
    const c = conn;
    c.open = false;
    conn = undefined;
    for (const p of c.pending.values()) p.reject(new Error('Disconnected'));
    c.pending.clear();
    sync.disconnect();
  };
  const sender = (c: NonNullable<typeof conn>) => (command: any) => {
    if (!c.open) return Promise.reject(new Error('Disconnected'));
    const id = ++cid;
    return new Promise((resolve, reject) => {
      c.pending.set(id, { resolve, reject });
      c.commands.push({ ...command, id });
    });
  };
  const check = (where: string) => {
    if (!on || !masking?.covered) return;
    if (wk.values?.full || masking.full) {
      stats.full++;
      return;
    }
    if (rows.size) stats.checked++;
    const have = new Set(masking.known.list(0, Infinity));
    for (const [id, d] of rows)
      for (const v of valuesOf(d))
        if (!have.has(v)) {
          problems.push(
            `seed ${seed} step ${log.length} after ${where}: covered but row ${id} value missing`,
          );
          return;
        }
  };
  const deliver = async () => {
    const c = conn;
    if (!c || c.queue.length === 0) return;
    const m = c.queue.shift();
    if (m.type === 'result') {
      const p = c.pending.get(m.id);
      c.pending.delete(m.id);
      if (m.ok) p?.resolve(m.value);
      else p?.reject(new Error(m.error));
    } else if (m.type === 'hello') {
      sync.hello(sender(c));
      rows.clear();
      for (const d of m.details) rows.set(d.summary.id, d);
    } else if (m.type === 'exchanges') {
      sync.push(m.known);
      m.exchanges.forEach((s: any, i: number) => m.details[i] && rows.set(s.id, m.details[i]));
      for (const id of m.removed) rows.delete(id);
    } else if (m.type === 'cleared') {
      sync.cleared();
      rows.clear();
    }
    await drain();
    check(m.type);
  };
  const serve = () => {
    const c = conn;
    if (!c || c.commands.length === 0) return;
    const cmd = c.commands.shift();
    void handle(cmd).then(
      (value) => c.open && c.queue.push({ type: 'result', id: cmd.id, ok: true, value }),
      (e) => c.open && c.queue.push({ type: 'result', id: cmd.id, ok: false, error: String(e.message) }),
    );
  };
  let clearedDue = 0;
  connect();
  for (let step = 0; step < steps; step++) {
    const r = pick(100);
    let op = '';
    if (r < 18) {
      op = 'add';
      const id = `e${n++}`;
      const t = tok();
      const d = {
        summary: { id, url: `https://a.test/x?access_token=${tok()}` },
        requestHeaders: [['authorization', `Bearer ${t}`]],
      };
      store.set(id, d);
      batcher.change(d.summary as any);
    } else if (r < 28 && store.size) {
      op = 'respond';
      const id = [...store.keys()][pick(store.size)]!;
      const d = { ...store.get(id), responseHeaders: [['set-cookie', `sid=${tok()}; Path=/`]] };
      store.set(id, d);
      batcher.change(d.summary);
    } else if (r < 32 && store.size) {
      op = 'evict';
      const id = [...store.keys()][pick(store.size)]!;
      store.delete(id);
      forget(id);
    } else if (r < 34) {
      op = 'clear';
      batcher.reset();
      store.clear();
      wk.clear();
      clearedDue = 1;
    } else if (r < 46) {
      op = 'flush';
      batcher.flush();
    } else if (r < 49) {
      op = 'reconnect';
      disconnect();
      connect();
    } else if (r < 52) {
      if (step === 0 || pick(6) === 0 || !on) {
        op = 'toggle';
        on = !on;
        sync.setOn(on);
      }
    } else if (r < 72) {
      op = 'deliver';
      await deliver();
    } else if (r < 88) {
      op = 'serve';
      serve();
      await drain();
    } else if (r < 91 && store.size && wk.watching) {
      op = 'getExchange';
      const id = [...store.keys()][pick(store.size)]!;
      wk.collect(store.get(id));
      batcher.flush();
    } else {
      op = 'yield';
      await immediate();
      await drain();
    }
    if (clearedDue && --clearedDue === 0) {
      broadcast({ type: 'cleared' });
      op += '+cleared';
    }
    log.push(op);
    if (problems.length) {
      problems.push(log.slice(-40).join(' '));
      break;
    }
  }
  // Quiesce: everything delivered, no failures → must end covered if on.
  for (let i = 0; i < 400 && !problems.length; i++) {
    batcher.flush();
    serve();
    await deliver();
    await immediate();
    await drain();
  }
  if (!problems.length && on && conn && !masking?.covered)
    problems.push(`seed ${seed}: never covered at rest`);
  if (!problems.length && on && conn) {
    stats.rest++;
    const a = JSON.stringify(masking.known.list(0, Infinity));
    const b = JSON.stringify(wk.values!.list(0, Infinity));
    if (a !== b)
      problems.push(
        `seed ${seed}: at rest the window's set differs from the backend's (${masking.known.size} vs ${wk.values!.size})`,
      );
    if (masking.full !== wk.values!.full) problems.push(`seed ${seed}: full differs at rest`);
    stats.epochs += Number((wk as any).epochs);
  }
  wk.stop();
  sync.setOn(false);
  return problems;
}

it('while covered, every row shown has its values in the window’s set, and at rest the sets agree', async () => {
  const all: string[] = [];
  for (let seed = 1; seed <= 400 && all.length < 6; seed++) all.push(...(await run(seed, 300)));
  expect(all).toEqual([]);
  // The checks really ran: covered with rows, full, and at rest.
  expect(stats.checked).toBeGreaterThan(1000);
  expect(stats.full).toBeGreaterThan(0);
  expect(stats.rest).toBeGreaterThan(100);
}, 120_000);

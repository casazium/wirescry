/**
 * The search box's `protocol` (`proto`) filter, and WebSockets (src/shared/query.ts). A captured
 * WebSocket is stored as ws or wss; an imported one as http or https, marked websocket. Either
 * way it answers to its own scheme and HTTP's, since it starts as an HTTP request.
 */
import { describe, expect, it } from 'vitest';
import type { ExchangeSummary } from '../src/shared/api';
import { compileFilter } from '../src/shared/filter';
import { compileQuery } from '../src/shared/query';

const row = (id: string, protocol: string, websocket?: true): ExchangeSummary => ({
  id,
  method: 'GET',
  protocol,
  httpVersion: '1.1',
  host: 'api.example.com',
  path: `/${id}`,
  url: `${protocol}://api.example.com/${id}`,
  startedAt: 0,
  status: websocket ? 101 : 200,
  ...(websocket ? { websocket } : {}),
});

const rows = [
  row('plain', 'http'),
  row('secure', 'https'),
  row('liveWs', 'ws', true),
  row('liveWss', 'wss', true),
  row('importedWs', 'http', true),
  row('importedWss', 'https', true),
];

/** The ids of the rows a search keeps. */
const kept = (query: string): string[] => {
  const compiled = compileQuery(query);
  expect(compiled.errors).toEqual([]);
  return rows.filter((r) => compiled.matches(r)).map((r) => r.id);
};

describe('protocol=', () => {
  it('https finds HTTPS requests and secure WebSockets, captured or imported', () => {
    expect(kept('protocol=https')).toEqual(['secure', 'liveWss', 'importedWss']);
  });

  it('http finds plain requests and plain WebSockets, captured or imported', () => {
    expect(kept('protocol=http')).toEqual(['plain', 'liveWs', 'importedWs']);
  });

  it('wss and ws find only WebSockets, captured or imported', () => {
    expect(kept('protocol=wss')).toEqual(['liveWss', 'importedWss']);
    expect(kept('protocol=ws')).toEqual(['liveWs', 'importedWs']);
  });

  it('ignores case, and proto means the same', () => {
    expect(kept('protocol=HTTPS')).toEqual(kept('protocol=https'));
    expect(kept('proto=wss')).toEqual(kept('protocol=wss'));
    expect(kept('PROTO=Ws')).toEqual(['liveWs', 'importedWs']);
  });

  it('reads a scheme stored in capitals the same way', () => {
    const shouted = row('shouted', 'WSS');
    expect(compileQuery('protocol=https').matches(shouted)).toBe(true);
    expect(compileQuery('protocol=wss').matches(shouted)).toBe(true);
    expect(compileQuery('protocol=http').matches(shouted)).toBe(false);
  });

  it('takes wildcards', () => {
    expect(kept('protocol=ws*')).toEqual(['liveWs', 'liveWss', 'importedWs', 'importedWss']);
    expect(kept('protocol=http*')).toEqual(rows.map((r) => r.id));
  });
});

describe('protocol!= and -protocol=', () => {
  it('leave out secure WebSockets with HTTPS, and keep the rest', () => {
    expect(kept('protocol!=https')).toEqual(['plain', 'liveWs', 'importedWs']);
    expect(kept('-protocol=https')).toEqual(['plain', 'liveWs', 'importedWs']);
  });

  it('leave out only WebSockets for ws and wss', () => {
    expect(kept('protocol!=wss')).toEqual(['plain', 'secure', 'liveWs', 'importedWs']);
    expect(kept('-proto=ws')).toEqual(['plain', 'secure', 'liveWss', 'importedWss']);
  });
});

describe('protocol~', () => {
  it('finds a part of either name', () => {
    expect(kept('protocol~tps')).toEqual(['secure', 'liveWss', 'importedWss']);
    expect(kept('protocol~ss')).toEqual(['liveWss', 'importedWss']);
  });
});

describe('everything else', () => {
  it('is as before for requests that aren’t WebSockets', () => {
    const plainOnly = (query: string) => kept(query).filter((id) => id === 'plain' || id === 'secure');
    expect(plainOnly('protocol=https')).toEqual(['secure']);
    expect(plainOnly('protocol=http')).toEqual(['plain']);
    expect(plainOnly('protocol!=http')).toEqual(['secure']);
    expect(plainOnly('protocol~http')).toEqual(['plain', 'secure']);
  });

  it('finds no row for a scheme none has', () => {
    expect(kept('protocol=ftp')).toEqual([]);
  });

  it('leaves other fields alone: a WebSocket isn’t a different method, host or type', () => {
    expect(kept('method=GET')).toEqual(rows.map((r) => r.id));
    expect(kept('host=api.example.com')).toEqual(rows.map((r) => r.id));
    expect(kept('protocol=https status=101')).toEqual(['liveWss', 'importedWss']);
  });
});

describe('With the quick filters', () => {
  const keptWith = (search: string, quick: Parameters<typeof compileFilter>[1]) => {
    const compiled = compileFilter(search, quick);
    return rows.filter((r) => compiled.matches(r)).map((r) => r.id);
  };

  it('WebSockets and protocol=https keep only the secure ones; with protocol=http, only the plain ones', () => {
    expect(keptWith('protocol=https', 'websocket')).toEqual(['liveWss', 'importedWss']);
    expect(keptWith('protocol=http', 'websocket')).toEqual(['liveWs', 'importedWs']);
  });

  it('All and protocol=https keep HTTPS requests and secure WebSockets', () => {
    expect(keptWith('protocol=https', 'all')).toEqual(['secure', 'liveWss', 'importedWss']);
  });

  it('leave the WebSockets quick filter and type=websocket as they were', () => {
    expect(keptWith('', 'websocket')).toEqual(['liveWs', 'liveWss', 'importedWs', 'importedWss']);
    expect(kept('type=websocket')).toEqual(['liveWs', 'liveWss', 'importedWs', 'importedWss']);
    expect(kept('-type=websocket')).toEqual(['plain', 'secure']);
  });
});

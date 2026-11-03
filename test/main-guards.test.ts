import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { guarded, isOnOrigin } from '../src/main/ipc-guard';

vi.mock('electron', () => ({ net: {}, protocol: {} }));
const { resolveAppFile } = await import('../src/main/app-protocol');

describe('IPC guard', () => {
  const origin = 'wirescry://app';
  const handler = guarded(origin, (_event: { senderFrame?: { url: string } | null }, n: number) => n * 2);

  it('passes calls from the UI', () => {
    expect(handler({ senderFrame: { url: 'wirescry://app/index.html' } }, 21)).toBe(42);
  });

  it('refuses calls from anywhere else', () => {
    for (const url of [
      'https://evil.example/',
      'wirescry://other/index.html',
      'wirescry://app.evil.example/',
      'http://app/',
      'file:///index.html',
      'not a url',
      '',
    ]) {
      expect(() => handler({ senderFrame: { url } }, 1), url).toThrow('Not allowed');
    }
    expect(() => handler({ senderFrame: null }, 1)).toThrow('Not allowed');
    expect(() => handler({}, 1)).toThrow('Not allowed');
  });

  it('matches the origin exactly', () => {
    expect(isOnOrigin('http://localhost:5173/x', 'http://localhost:5173')).toBe(true);
    expect(isOnOrigin('http://localhost:5174/x', 'http://localhost:5173')).toBe(false);
  });

  it('is used by every IPC handler in the main process', () => {
    const dir = path.join(import.meta.dirname, '../src/main');
    const uses: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(path.join(dir, file), 'utf8')
        // Comments don't count, either way.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const match of source.matchAll(/ipcMain\.(handle|handleOnce|on|once)\b/g)) {
        uses.push(`${file}: ${source.slice(match.index, match.index + 160)}`);
      }
    }
    const handles = uses.filter((u) => /ipcMain\.(handle|handleOnce)\b/.test(u));
    // The only one is inside the guarded `handle` helper in index.ts.
    expect(handles).toHaveLength(1);
    expect(handles[0]).toMatch(/^index\.ts: ipcMain\.handle\(channel, guarded\(uiOrigin, handler\)/);
    // Listeners check the sender as their first statement.
    const listeners = uses.filter((u) => /ipcMain\.(on|once)\b/.test(u));
    expect(listeners.length).toBeGreaterThan(0);
    for (const listener of listeners) {
      expect(listener).toMatch(/=> \{\s*if \(!isFromOurUi\(event\.senderFrame\?\.url \?\? ''\)\) return;/);
    }
  });
});

describe('wirescry:// files', () => {
  const root = path.resolve('/srv/wirescry/renderer');
  const ok = (url: string) => resolveAppFile(root, url);

  it('serves files inside the UI folder, and / as index.html', () => {
    expect(ok('wirescry://app/')).toEqual({ file: path.join(root, 'index.html') });
    expect(ok('wirescry://app/assets/main.js')).toEqual({ file: path.join(root, 'assets', 'main.js') });
    expect(ok('wirescry://app/a%20b.css')).toEqual({ file: path.join(root, 'a b.css') });
  });

  it('refuses paths that climb out of it, however they are spelled', () => {
    for (const url of [
      'wirescry://app/%2e%2e/secret.txt',
      'wirescry://app/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd',
      'wirescry://app/assets/..%2f..%2f..%2fetc%2fpasswd',
      'wirescry://app/..%5c..%5cwindows%5cwin.ini',
      'wirescry://app/%2e%2e',
    ]) {
      // The URL parser collapses some of these itself; either way nothing outside root is served.
      const result = ok(url);
      if ('file' in result) expect(result.file.startsWith(root + path.sep), url).toBe(true);
      else expect([400, 403], url).toContain(result.status);
    }
    // The parser turns /%2e%2e/ into / before the check: harmless, it stays inside.
    expect(ok('wirescry://app/%2e%2e/secret.txt')).toEqual({ file: path.join(root, 'secret.txt') });
    // These survive the parser, so the folder check itself must refuse them.
    expect(ok('wirescry://app/assets/..%2f..%2fsecret.txt')).toEqual({ status: 403 });
    // A sibling whose name starts with the folder's: a startsWith check without the
    // separator would let this through.
    expect(ok('wirescry://app/..%2frenderer-evil%2fx.js')).toEqual({ status: 403 });
    // The folder itself.
    expect(ok('wirescry://app/assets/..%2f')).toEqual({ status: 403 });
  });

  it('refuses other hosts, malformed escapes and NUL bytes', () => {
    expect(ok('wirescry://evil/index.html')).toEqual({ status: 404 });
    expect(ok('wirescry://app/%E0%A4%A')).toEqual({ status: 400 });
    expect(ok('wirescry://app/index.html%00.png')).toEqual({ status: 400 });
  });
});

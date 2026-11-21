/**
 * Drives the real app with View › Hide Secrets: traffic with secrets planted in a URL, headers, a
 * JSON body, a form and a UTF-16 body; the switch turned on from the menu; the window searched
 * for them (text and every attribute) in each view, and the clipboard after each Copy. Then a
 * restart, which keeps it on, and the badge, which turns it off. Runs against out/ (npm run build
 * first), with its own data folder.
 */
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
/** Screenshots go here when set, to look at by eye. */
const shots = process.env.WIRESCRY_SHOTS;

// Fake tokens, built at run time so the file itself holds nothing a secret scanner flags.
const ACCESS = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const BEARER = 'mK7vQ2xZ' + '9pLw4RtY8nB3';
const PASSWORD = 'hunter2' + 'Correct9Horse';
const SECRETS = { ACCESS, BEARER, PASSWORD };

let app: ElectronApplication;
let page: Page;
let upstream: http.Server;
let upstreamPort: number;
let userData: string;

async function launch(): Promise<void> {
  app = await electron.launch({
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), root, `--user-data-dir=${userData}`],
    env: { ...process.env, WIRESCRY_DISABLE_UPDATES: '1' } as Record<string, string>,
    timeout: 60_000,
  });
  page = await app.firstWindow();
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url?.startsWith('/login')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: ACCESS, user: 'ada' }));
      } else if (req.url === '/echo') {
        res.setHeader('content-type', 'text/plain');
        res.end(`you sent ${BEARER}`);
      } else if (req.url === '/events') {
        res.setHeader('content-type', 'text/event-stream');
        res.end(
          `event: login\nid: 1\ndata: {"access_token":"${ACCESS}"}\n\n: saw ${BEARER}\n\ndata: all good\n\n`,
        );
      } else if (req.url === '/utf16') {
        res.setHeader('content-type', 'application/x-www-form-urlencoded');
        res.end(Buffer.from(`user=ada&password=${PASSWORD}`, 'utf16le'));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  // A WebSocket that sends secrets as soon as it opens: in text, in JSON, and in a binary frame.
  const sockets = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) =>
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.send(`welcome ${BEARER}`);
      ws.send(JSON.stringify({ token: ACCESS }));
      ws.send(Buffer.from(JSON.stringify({ password: PASSWORD })), { binary: true });
    }),
  );
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
  userData = await mkdtemp(path.join(os.tmpdir(), 'wirescry-hide-secrets-'));
  await writeFile(path.join(userData, 'settings.json'), JSON.stringify({ androidSetup: false }));
  if (shots) await mkdir(shots, { recursive: true });
  await launch();
});

afterAll(async () => {
  await app?.close().catch(() => undefined);
  upstream?.close();
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * Opens a WebSocket through Wirescry's proxy (plain HTTP, so the proxy sees the upgrade), sends one
 * message, reads what the server sends, and closes.
 */
function webSocketViaProxy(proxyPort: number, send: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(
        [
          `GET http://127.0.0.1:${upstreamPort}/socket HTTP/1.1`,
          `Host: 127.0.0.1:${upstreamPort}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      );
    });
    let upgraded = false;
    socket.on('data', (chunk: Buffer) => {
      if (upgraded || !chunk.toString('latin1').startsWith('HTTP/1.1 101')) return;
      upgraded = true;
      // One masked text frame from the client (payload under 126 bytes).
      const payload = Buffer.from(send);
      const key = Buffer.from([1, 2, 3, 4]);
      const masked = Buffer.from(payload.map((b, i) => b ^ key[i % 4]!));
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), key, masked]));
      setTimeout(() => {
        socket.end();
        resolve();
      }, 1000);
    });
    socket.on('error', reject);
  });
}

/** Sends a request through Wirescry's proxy to the local upstream. */
function viaProxy(
  proxyPort: number,
  pathname: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path: `http://127.0.0.1:${upstreamPort}${pathname}`,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

const pill = () => page.getByTestId('proxy-status');
const rows = () => page.getByTestId('exchange-row');
const row = (text: string) => rows().filter({ hasText: text }).first();
const badge = () => page.getByRole('button', { name: 'Secrets hidden' });

/** Everything the window shows or says: its text, and every attribute of every element. */
const everything = (): Promise<string> =>
  // Runs in the window; this file is type-checked without the DOM's types.
  page.evaluate(() => {
    const body = (globalThis as unknown as { document: { body: DomElement } }).document.body;
    const parts = [body.innerText];
    for (const el of body.querySelectorAll('*')) {
      for (const attr of el.attributes) parts.push(attr.value);
    }
    return parts.join('\n');
  });

interface DomElement {
  innerText: string;
  querySelectorAll(selector: string): Iterable<{ attributes: Iterable<{ value: string }> }>;
}
/**
 * Secrets found in text, whole or in part: any six characters of one in a row, as written or
 * with a dot between each (a UTF-16 body's ASCII column in the Hex view). A hex dump splits a
 * value across its rows, so a whole one wouldn't be found there.
 */
const leaked = (text: string): string[] =>
  Object.entries(SECRETS)
    .filter(([, secret]) => {
      for (let i = 0; i + 6 <= secret.length; i++) {
        const piece = secret.slice(i, i + 6);
        if (text.includes(piece) || text.includes(piece.split('').join('.'))) return true;
      }
      return false;
    })
    .map(([name]) => name);

const menuItem = () =>
  app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('hide-secrets');
    return item ? { enabled: item.enabled, checked: item.checked } : undefined;
  });
const clickMenu = () =>
  app.evaluate(({ Menu, BrowserWindow }) => {
    const item = Menu.getApplicationMenu()!.getMenuItemById('hide-secrets')!;
    // As a real click does: the checkbox flips, then its handler runs.
    item.checked = !item.checked;
    item.click(undefined, BrowserWindow.getAllWindows()[0], undefined);
  });
const clipboardText = () => app.evaluate(({ clipboard }) => clipboard.readText());
const shot = async (name: string): Promise<void> => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

/** Opens a row and waits until its bodies have settled (no "Loading…" or "Hiding secrets…"). */
async function open(text: string): Promise<void> {
  // Clicking the selected row closes it.
  if ((await row(text).getAttribute('aria-selected')) !== 'true') await row(text).click();
  await page.locator('.detail').waitFor();
  await expect
    .poll(
      async () => (await page.locator('.detail').innerText()).match(/Loading…|Hiding secrets…|Formatting…/),
      {
        timeout: 30_000,
      },
    )
    .toBeNull();
}

/** Each body's views in turn, the window checked in each, and each Copy's text checked. */
async function checkEveryView(label: string): Promise<void> {
  expect(leaked(await everything()), label).toEqual([]);
  for (const tab of ['Formatted', 'Fields', 'Text', 'Hex']) {
    const buttons = page.locator('.detail .body-view button.tab', { hasText: new RegExp(`^${tab}$`) });
    for (let i = 0; i < (await buttons.count()); i++) {
      await buttons.nth(i).click();
      expect(leaked(await everything()), `${label} ${tab}`).toEqual([]);
    }
  }
  const copies = page.locator('.detail .body-view button', { hasText: /^Copy$/ });
  for (let i = 0; i < (await copies.count()); i++) {
    await app.evaluate(({ clipboard }) => clipboard.writeText(''));
    await copies.nth(i).click();
    await expect.poll(clipboardText).not.toBe('');
    expect(leaked(await clipboardText()), `${label} body Copy`).toEqual([]);
  }
}

it('hides secrets in the real window, copies what it shows, and keeps the switch across a restart', async () => {
  await expect.poll(async () => (await pill().textContent()) ?? '', { timeout: 60_000 }).toMatch(/^Proxy on/);
  const proxyPort = Number((await pill().textContent())!.split(':').at(-1));
  expect(
    await viaProxy(proxyPort, `/login?access_token=${ACCESS}`, {
      headers: { authorization: `Bearer ${BEARER}` },
    }),
  ).toBe(200);
  expect(await viaProxy(proxyPort, '/echo')).toBe(200);
  expect(
    await viaProxy(proxyPort, '/login/form', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `user=ada&password=${PASSWORD}`,
    }),
  ).toBe(200);
  expect(await viaProxy(proxyPort, '/utf16')).toBe(200);
  expect(await viaProxy(proxyPort, '/events')).toBe(200);
  await webSocketViaProxy(proxyPort, JSON.stringify({ password: PASSWORD }));
  await expect.poll(() => rows().count(), { timeout: 30_000 }).toBe(6);

  // Off: the secrets show (so the checks below can find them).
  expect(await menuItem()).toEqual({ enabled: true, checked: false });
  await open('/login?');
  expect(leaked(await everything())).toEqual(expect.arrayContaining(['ACCESS', 'BEARER']));
  await shot('1-off');

  // On, from the menu: ticked, a badge, and nothing in any view, tooltip or label.
  await clickMenu();
  await badge().waitFor();
  expect(await menuItem()).toEqual({ enabled: true, checked: true });
  for (const name of ['/login?', '/echo', '/login/form', '/utf16']) {
    await open(name);
    await checkEveryView(name);
    await shot(`2-on-${name.replace(/\W/g, '')}`);
  }

  // A WebSocket's messages and an event stream's events, masked: each message opened, in each view.
  await open('/socket');
  const messages = page.getByTestId('ws-message');
  await expect.poll(() => messages.count(), { timeout: 30_000 }).toBe(4);
  expect(await page.locator('.ws').innerText()).toContain('welcome [redacted]');
  for (let i = 0; i < 4; i++) {
    await messages.nth(i).click();
    await checkEveryView(`/socket message ${i}`);
    await messages.nth(i).click();
  }
  await page.getByRole('searchbox', { name: 'Search messages' }).fill(BEARER.slice(0, 8));
  await expect.poll(() => messages.count()).toBe(0);
  await page.getByRole('searchbox', { name: 'Search messages' }).fill('');
  await shot('2-on-socket');
  await open('/events');
  await expect
    .poll(async () => page.locator('.sse').innerText(), { timeout: 30_000 })
    .toContain('[redacted]');
  await checkEveryView('/events');
  await shot('2-on-events');

  // Copy URL copies the masked URL; Copy as curl, the real request.
  await open('/login?');
  await page.getByRole('button', { name: 'Copy URL' }).click();
  await expect.poll(clipboardText).toBe(`http://127.0.0.1:${upstreamPort}/login?access_token=[redacted]`);
  await page.getByRole('button', { name: 'Copy as curl' }).click();
  await expect.poll(clipboardText).toContain(BEARER);
  expect(await clipboardText()).toContain(ACCESS);

  // A restart keeps it on.
  await app.close();
  await launch();
  await badge().waitFor({ timeout: 60_000 });
  await expect.poll(menuItem, { timeout: 15_000 }).toEqual({ enabled: true, checked: true });
  await expect.poll(async () => (await pill().textContent()) ?? '', { timeout: 60_000 }).toMatch(/^Proxy on/);
  const port2 = Number((await pill().textContent())!.split(':').at(-1));
  expect(
    await viaProxy(port2, `/login?access_token=${ACCESS}`, {
      headers: { authorization: `Bearer ${BEARER}` },
    }),
  ).toBe(200);
  await expect.poll(() => rows().count(), { timeout: 30_000 }).toBe(1);
  await open('/login?');
  await checkEveryView('after restart');
  await shot('3-after-restart');

  // The badge turns it off: unticked, and the real values back.
  await badge().click();
  await expect.poll(menuItem).toEqual({ enabled: true, checked: false });
  await expect
    .poll(async () => leaked(await everything()), { timeout: 30_000 })
    .toEqual(expect.arrayContaining(['ACCESS', 'BEARER']));
  await shot('4-off-again');
});

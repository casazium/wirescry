/**
 * Drives the real app's MCP server: traffic with planted secrets, the server turned on from
 * Setup's switch, the tools called over HTTP as an agent would, every answer searched for the
 * secrets, and the toolbar's "Agent active" badge. Runs against out/ (npm run build first), with
 * its own data folder.
 */
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const shots = process.env.WIRESCRY_SHOTS;

// Fake tokens, built at run time so the file itself holds nothing a secret scanner flags.
const ACCESS = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const BEARER = 'mK7vQ2xZ' + '9pLw4RtY8nB3';
const SECRETS = { ACCESS, BEARER };

let app: ElectronApplication;
let page: Page;
let upstream: http.Server;
let upstreamPort: number;
let userData: string;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    req.resume();
    if (req.url?.startsWith('/login')) {
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-echo', BEARER);
      res.end(JSON.stringify({ access_token: ACCESS }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
  userData = await mkdtemp(path.join(os.tmpdir(), 'wirescry-mcp-'));
  await writeFile(path.join(userData, 'settings.json'), JSON.stringify({ androidSetup: false }));
  if (shots) await mkdir(shots, { recursive: true });
  app = await electron.launch({
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), root, `--user-data-dir=${userData}`],
    env: { ...process.env, WIRESCRY_DISABLE_UPDATES: '1' } as Record<string, string>,
    timeout: 60_000,
  });
  page = await app.firstWindow();
});

afterAll(async () => {
  await app?.close().catch(() => undefined);
  upstream?.close();
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

function viaProxy(
  proxyPort: number,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: '127.0.0.1', port: proxyPort, path: `http://127.0.0.1:${upstreamPort}${pathname}`, headers },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      )
      .on('error', reject);
  });
}

const leaked = (text: string): string[] =>
  Object.entries(SECRETS)
    .filter(([, s]) => text.includes(s))
    .map(([name]) => name);

/** The settings file the app keeps in its data folder: where the token is. */
async function mcpSettings(): Promise<{ enabled: boolean; port: number; token: string } | undefined> {
  const file = path.join(userData, 'settings.json');
  return (
    JSON.parse(await readFile(file, 'utf8')) as { mcp?: { enabled: boolean; port: number; token: string } }
  ).mcp;
}

let nextId = 1;
async function call(
  url: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': 'wirescry-smoke-agent/1.0',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  expect(res.status).toBe(200);
  return res.text();
}

it('lets an agent read captured traffic, masked, once turned on in Setup', async () => {
  const pill = page.getByTestId('proxy-status');
  await expect.poll(async () => (await pill.textContent()) ?? '', { timeout: 60_000 }).toMatch(/^Proxy on/);
  const proxyPort = Number((await pill.textContent())!.split(':').at(-1));
  expect(
    await viaProxy(proxyPort, `/login?access_token=${ACCESS}`, { authorization: `Bearer ${BEARER}` }),
  ).toBe(200);
  await expect.poll(() => page.getByTestId('exchange-row').count(), { timeout: 30_000 }).toBe(1);

  // Off until turned on.
  expect(await mcpSettings()).toBeUndefined();
  await page.locator('nav.views button', { hasText: 'Setup' }).click();
  const box = page.getByRole('checkbox', { name: 'Let AI agents read captured traffic' });
  await box.scrollIntoViewIfNeeded();
  // Ticked once the backend says it's on, not on the click itself.
  await box.click();
  await expect.poll(() => box.isChecked(), { timeout: 15_000 }).toBe(true);
  await page.getByText('Recent calls').waitFor({ timeout: 30_000 });
  const mcp = (await mcpSettings())!;
  expect(mcp).toMatchObject({ enabled: true, port: 45450 });
  const url = `http://127.0.0.1:${mcp.port}/mcp`;
  // The token isn't on the page until asked for.
  expect(await page.locator('body').innerText()).not.toContain(mcp.token);
  if (shots) await page.screenshot({ path: path.join(shots, 'mcp-setup.png') });

  const list = await call(url, mcp.token, 'list_exchanges', {});
  expect(leaked(list)).toEqual([]);
  expect(list).toContain('access_token=[redacted]');
  const id = /\\"id\\":\\"([^\\"]+)\\"/.exec(list)![1]!;
  const detail = await call(url, mcp.token, 'get_exchange', { id });
  expect(leaked(detail)).toEqual([]);
  expect(detail).toContain('Bearer [redacted]');
  const body = await call(url, mcp.token, 'get_body', { id, side: 'response' });
  expect(leaked(body)).toEqual([]);
  expect(body).toContain('[redacted]');

  // A wrong token is turned away (the other guards are tested in test/mcp-http.test.ts).
  expect((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer nope' } })).status).toBe(401);

  // The badge, and the calls listed.
  await page.getByRole('button', { name: 'Agent active' }).waitFor({ timeout: 15_000 });
  await expect
    .poll(() => page.getByRole('table', { name: 'Recent MCP calls' }).innerText())
    .toContain('get_body');
  expect(await page.getByRole('table', { name: 'Recent MCP calls' }).innerText()).toContain(
    'wirescry-smoke-agent',
  );
  if (shots) await page.screenshot({ path: path.join(shots, 'mcp-active.png') });

  // Turned off: it stops listening.
  await box.click();
  await expect.poll(() => box.isChecked(), { timeout: 15_000 }).toBe(false);
  await expect.poll(async () => (await mcpSettings())?.enabled).toBe(false);
  await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
});

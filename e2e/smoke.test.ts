/**
 * Drives the real app: capture traffic, open a gzip and an HTML body (which once crashed
 * the backend), kill the backend and check the list survives with a notice, and check the
 * Pro tab still works. Runs against out/ (npm run build first); not the packaged app, whose
 * fuses turn off the --inspect that Playwright attaches with. On Linux, run under xvfb-run.
 */
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
let app: ElectronApplication;
let page: Page;
let upstream: http.Server;
let upstreamPort: number;
let userData: string;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/data.json') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-encoding', 'gzip');
      res.end(gzipSync(JSON.stringify({ hello: 'smoke test', items: [1, 2, 3] })));
    } else if (req.url === '/page.html') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><body><div><p>Formatted by the backend</p></div></body></html>');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;

  userData = await mkdtemp(path.join(os.tmpdir(), 'wirescry-smoke-'));
  app = await electron.launch({
    // Electron runs this folder, which loads the build in out/.
    args: [
      // Linux CI can't set up Chromium's sandbox helper (it needs root).
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      root,
      `--user-data-dir=${userData}`,
    ],
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

/** Sends a GET through Wirescry's proxy to the local upstream. */
function viaProxy(proxyPort: number, pathname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: '127.0.0.1', port: proxyPort, path: `http://127.0.0.1:${upstreamPort}${pathname}` },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      )
      .on('error', reject);
  });
}

const pill = () => page.getByTestId('proxy-status');
const rows = () => page.getByTestId('exchange-row');
const row = (text: string) => rows().filter({ hasText: text });

/** The backend's process id: the utility process that isn't Chromium's own network service. */
async function backendPid(): Promise<number> {
  const metrics = await app.evaluate(({ app: electronApp }) =>
    electronApp
      .getAppMetrics()
      .map((m) => ({ pid: m.pid, type: m.type, name: m.name, serviceName: m.serviceName })),
  );
  const backend = metrics.find(
    (m) =>
      m.type === 'Utility' && (m.name === 'Wirescry Backend' || m.serviceName === 'node.mojom.NodeService'),
  );
  if (!backend) throw new Error(`No backend process in ${JSON.stringify(metrics)}`);
  return backend.pid;
}

it('captures traffic, opens gzip and HTML bodies, survives a backend crash, composes, and keeps Pro working', async () => {
  // Started, with the proxy listening.
  await expect
    .poll(async () => (await pill().textContent()) ?? '', { timeout: 60_000 })
    .toMatch(/^Proxy on 127\.0\.0\.1:\d+$/);
  const proxyPort = Number((await pill().textContent())!.split(':').at(-1));

  // Traffic shows up.
  expect(await viaProxy(proxyPort, '/data.json')).toBe(200);
  expect(await viaProxy(proxyPort, '/page.html')).toBe(200);
  // 30 s, like the waits below: once, on a slow arm64 runner, 15 s passed with no rows.
  await expect
    .poll(() => rows().count(), { timeout: 30_000 })
    .toBe(2)
    .catch(async (error: unknown) => {
      // Say what the window showed, so a failure here can be told apart from a slow machine.
      const shown = await page
        .locator('body')
        .innerText()
        .catch((e: Error) => `(couldn't read: ${e.message})`);
      console.error(`No rows. The window showed:\n${shown.slice(0, 3000)}`);
      throw error;
    });

  // Opening an HTML body formats it in a backend worker, and a gzip body decodes: both
  // crashed the backend until 0.1.4.
  await row('/page.html').click();
  await page.locator('pre[data-language="html"]').waitFor({ timeout: 30_000 });
  expect(await page.locator('pre[data-language="html"]').textContent()).toContain('Formatted by the backend');
  await row('/data.json').click();
  await page.locator('pre.code', { hasText: '"hello": "smoke test"' }).waitFor({ timeout: 30_000 });
  expect(await pill().textContent()).toMatch(/^Proxy on/);
  expect(await page.locator('.restart-notice').count()).toBe(0);

  // The backend dies: the list stays, dimmed, with a notice, and the proxy comes back.
  process.kill(await backendPid(), 'SIGKILL');
  await page.locator('.restart-notice').waitFor({ timeout: 60_000 });
  expect(await page.locator('.restart-notice').textContent()).toContain('stopped unexpectedly');
  await expect.poll(() => page.locator('.row.stale').count(), { timeout: 15_000 }).toBe(2);
  await expect.poll(async () => (await pill().textContent()) ?? '', { timeout: 60_000 }).toMatch(/^Proxy on/);
  const newPort = Number((await pill().textContent())!.split(':').at(-1));
  expect(await viaProxy(newPort, '/data.json')).toBe(200);
  await expect.poll(() => rows().count(), { timeout: 15_000 }).toBe(3);

  // The composer sends through the (restarted) proxy, and the request shows in Traffic.
  await page.locator('nav.views button', { hasText: 'Compose' }).click();
  await page.getByLabel('URL').fill(`http://127.0.0.1:${upstreamPort}/data.json`);
  await page.getByRole('button', { name: 'Send' }).click();
  await page
    .locator('.composer-response pre.code', { hasText: '"hello": "smoke test"' })
    .waitFor({ timeout: 30_000 });
  await page.locator('nav.views button', { hasText: 'Traffic' }).click();
  await expect.poll(() => rows().filter({ hasText: 'Sent' }).count(), { timeout: 15_000 }).toBe(1);

  // With Pro built in, its tab answers after the restart (it once stuck at "Not connected").
  const rulesTab = page.locator('nav.views button', { hasText: 'Rules' });
  if ((await rulesTab.count()) > 0) {
    await rulesTab.click();
    const view = page.locator('.plugin-view-host:not([hidden])');
    await expect
      .poll(async () => (await view.textContent()) ?? '', { timeout: 30_000 })
      .toMatch(/Rules is part of Wirescry Pro|New rule/);
    expect(await view.textContent()).not.toMatch(/Not connected|isn’t available|stopped working/);
  }
});

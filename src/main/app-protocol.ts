import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';

/** Packaged builds serve the UI from wirescry://app, giving it a fixed origin the API can check. */
export const APP_SCHEME = 'wirescry';
export const APP_ORIGIN = `${APP_SCHEME}://app`;

export function registerAppSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** Serves files from `rootDir`, refusing anything outside it. Call after app is ready. */
export function handleAppProtocol(rootDir: string, csp: string): void {
  const root = path.resolve(rootDir);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response(null, { status: 404 });
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(root, `.${relative}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      return new Response(null, { status: 403 });
    }
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', csp);
    return new Response(response.body, { status: response.status, headers });
  });
}

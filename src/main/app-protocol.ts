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

/**
 * The file a wirescry:// request asks for, inside `root`, or the status to refuse it with:
 * 404 for another host, 400 for a malformed path, 403 for anything outside `root`.
 */
export function resolveAppFile(root: string, requestUrl: string): { file: string } | { status: number } {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { status: 400 };
  }
  if (url.host !== 'app') return { status: 404 };
  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  } catch {
    return { status: 400 };
  }
  if (relative.includes('\0')) return { status: 400 };
  const file = path.resolve(root, `.${relative}`);
  if (file === root || !file.startsWith(root + path.sep)) return { status: 403 };
  return { file };
}

/** Serves files from `rootDir`, refusing anything outside it. Call after app is ready. */
export function handleAppProtocol(rootDir: string, csp: string): void {
  const root = path.resolve(rootDir);
  protocol.handle(APP_SCHEME, async (request) => {
    const resolved = resolveAppFile(root, request.url);
    if ('status' in resolved) return new Response(null, { status: resolved.status });
    const file = resolved.file;
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', csp);
    return new Response(response.body, { status: response.status, headers });
  });
}

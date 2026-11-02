/** Extensions for common body types, when the URL doesn't end in one. */
const EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'text/html': 'html',
  'text/css': 'css',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'application/wasm': 'wasm',
};

/** Replaces characters file systems refuse (control characters, and <>:"/\|?*) with _. */
export function safeName(name: string): string {
  return [...name]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || '<>:"/\\|?*'.includes(c) ? '_' : c))
    .join('');
}

/**
 * A file name to suggest when saving a body: the URL's last path segment, with an
 * extension for its type if it has none, e.g. `users.json`. Falls back to the host.
 */
export function bodyFileName(
  url: string,
  contentType: string | undefined,
  side: 'request' | 'response',
): string {
  let segment = '';
  let host = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    segment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? '');
  } catch {
    // Use the fallback.
  }
  let base = safeName(segment || host || 'body').slice(0, 100);
  if (side === 'request') base = `${base}-request`;
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = EXTENSIONS[type] ?? (type.endsWith('+json') ? 'json' : undefined);
  if (extension && !new RegExp(`\\.${extension}$`, 'i').test(base)) return `${base}.${extension}`;
  return /\.[a-z0-9]{1,6}$/i.test(base) ? base : `${base}.bin`;
}

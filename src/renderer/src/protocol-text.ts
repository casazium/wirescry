/** The Overview's Protocol line: the HTTP version, and the URL's scheme. */

/** "2.0" as people say it: HTTP/2. */
export function httpVersionText(version: string): string {
  const major = /^(\d+)\.0$/.exec(version);
  return major && Number(major[1]) >= 2 ? `HTTP/${major[1]}` : `HTTP/${version}`;
}

/**
 * E.g. "HTTP/2 (https://)" or "HTTP/1.1 (http://)". The scheme is the URL's, which says how
 * Wirescry reaches the server, not whether the client's own connection was encrypted: BusyBox
 * wget sends https:// URLs to the proxy in plain text.
 */
export function protocolText(protocol: string, httpVersion: string): string {
  const scheme = protocol.toLowerCase();
  // An imported request whose file didn't say.
  const version = httpVersion === '' ? 'HTTP version unknown' : httpVersionText(httpVersion);
  return /^(https?|wss?)$/.test(scheme) ? `${version} (${scheme}://)` : version;
}

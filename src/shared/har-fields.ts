/**
 * Small pieces of HAR (HTTP Archive 1.2) shared by export (src/backend/har.ts) and redaction
 * (src/backend/har-redact.ts). Pure, with no imports, so a worker can load it from source.
 */

/** Whether a Content-Type is an HTML form's default, whose fields HAR lists as postData.params. */
export const isFormEncoded = (type: string | undefined): boolean =>
  type?.split(';')[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded';

/** A URL's query as HAR's queryString: names and values, decoded. Empty if it isn't a URL. */
export function queryString(url: string): Array<{ name: string; value: string }> {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** Decodes UTF-8, or returns undefined if the bytes don't look like text. */
export function bytesToText(bytes: Uint8Array): string | undefined {
  try {
    return looksLikeText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** The text, or undefined if it has too many control characters to be shown as text. */
export function looksLikeText(text: string): string | undefined {
  const sample = text.slice(0, 4096);
  // eslint-disable-next-line no-control-regex
  const control = sample.match(/[\u0000-\u0008\u000e-\u001f]/g)?.length ?? 0;
  return control > sample.length * 0.01 ? undefined : text;
}

const HEX_ROW = 16;

/**
 * Classic hex dump: offset, 16 bytes in hex, then printable ASCII. Bytes in `masked` ([start,
 * end), sorted and apart) show as `••` in hex and `•` in ASCII: secrets hidden by Hide Secrets.
 */
export function hexDump(
  bytes: Uint8Array,
  limit = 64 * 1024,
  masked: ReadonlyArray<readonly [number, number]> = [],
): string {
  const end = Math.min(bytes.length, limit);
  const rows: string[] = [];
  let range = 0;
  const isMasked = (at: number): boolean => {
    while (range < masked.length && masked[range]![1] <= at) range++;
    return range < masked.length && masked[range]![0] <= at;
  };
  for (let offset = 0; offset < end; offset += HEX_ROW) {
    const hex: string[] = [];
    let ascii = '';
    for (let at = offset; at < Math.min(offset + HEX_ROW, end); at++) {
      const b = bytes[at]!;
      if (isMasked(at)) {
        hex.push('••');
        ascii += '•';
      } else {
        hex.push(b.toString(16).padStart(2, '0'));
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      }
    }
    rows.push(`${offset.toString(16).padStart(8, '0')}  ${hex.join(' ').padEnd(HEX_ROW * 3 - 1)}  ${ascii}`);
  }
  if (bytes.length > end) rows.push(`… ${bytes.length - end} more bytes`);
  return rows.join('\n');
}

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
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const sample = text.slice(0, 4096);
    // eslint-disable-next-line no-control-regex
    const control = sample.match(/[\u0000-\u0008\u000e-\u001f]/g)?.length ?? 0;
    return control > sample.length * 0.01 ? undefined : text;
  } catch {
    return undefined;
  }
}

const HEX_ROW = 16;

/** Classic hex dump: offset, 16 bytes in hex, then printable ASCII. */
export function hexDump(bytes: Uint8Array, limit = 64 * 1024): string {
  const end = Math.min(bytes.length, limit);
  const rows: string[] = [];
  for (let offset = 0; offset < end; offset += HEX_ROW) {
    const row = bytes.subarray(offset, Math.min(offset + HEX_ROW, end));
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    rows.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(HEX_ROW * 3 - 1)}  ${ascii}`);
  }
  if (bytes.length > end) rows.push(`… ${bytes.length - end} more bytes`);
  return rows.join('\n');
}

/** The Overview's Protocol line (src/renderer/src/protocol-text.ts). */
import { describe, expect, it } from 'vitest';
import { httpVersionText, protocolText } from '../src/renderer/src/protocol-text';

describe('httpVersionText', () => {
  it('says HTTP/2 and HTTP/3 as people do, and keeps 1.0 and 1.1 as they are', () => {
    expect(httpVersionText('2.0')).toBe('HTTP/2');
    expect(httpVersionText('3.0')).toBe('HTTP/3');
    expect(httpVersionText('1.1')).toBe('HTTP/1.1');
    expect(httpVersionText('1.0')).toBe('HTTP/1.0');
  });

  it('shows any other version as it came', () => {
    expect(httpVersionText('0.9')).toBe('HTTP/0.9');
  });
});

describe('protocolText', () => {
  it('gives the version, then the URL’s scheme, once each', () => {
    expect(protocolText('https', '2.0')).toBe('HTTP/2 (https://)');
    expect(protocolText('http', '1.1')).toBe('HTTP/1.1 (http://)');
    expect(protocolText('wss', '1.1')).toBe('HTTP/1.1 (wss://)');
    expect(protocolText('ws', '1.1')).toBe('HTTP/1.1 (ws://)');
    expect(protocolText('HTTPS', '1.1')).toBe('HTTP/1.1 (https://)');
  });

  it('never claims the connection was encrypted: an https:// URL can arrive in plain text', () => {
    // BusyBox wget's request: an https:// URL, sent to the proxy unencrypted.
    expect(protocolText('https', '1.1')).not.toMatch(/encrypt/i);
    expect(protocolText('http', '1.1')).not.toMatch(/encrypt/i);
  });

  it('shows only the version for a scheme it doesn’t know', () => {
    expect(protocolText('ftp', '1.1')).toBe('HTTP/1.1');
    expect(protocolText('', '1.1')).toBe('HTTP/1.1');
  });

  it('says the version is unknown when an imported file didn’t give one, never “HTTP/”', () => {
    expect(protocolText('https', '')).toBe('HTTP version unknown (https://)');
    expect(protocolText('ws', '')).toBe('HTTP version unknown (ws://)');
    expect(protocolText('', '')).toBe('HTTP version unknown');
    expect(protocolText('https', '')).not.toContain('HTTP/');
  });
});

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LoggerOptions {
  /** Start a new file past this size, keeping one previous file. */
  maxBytes?: number;
  /** Strings to replace with [redacted] wherever they appear, e.g. the API token. */
  secrets?: string[];
  /** Write buffered lines at least this often. */
  flushMs?: number;
}

/**
 * Appends timestamped lines to `<dir>/wirescry.log`. Lines are buffered and
 * written in batches; when the file passes `maxBytes` it's renamed to
 * `wirescry.old.log`, replacing the previous one.
 */
export class FileLogger {
  readonly file: string;
  private readonly previous: string;
  private readonly maxBytes: number;
  private secrets: string[];
  private size: number;
  private buffer: string[] = [];
  private timer: ReturnType<typeof setInterval>;

  constructor(dir: string, options: LoggerOptions = {}) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'wirescry.log');
    this.previous = path.join(dir, 'wirescry.old.log');
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.secrets = (options.secrets ?? []).filter((s) => s.length >= 8);
    try {
      this.size = statSync(this.file).size;
    } catch {
      this.size = 0;
    }
    this.timer = setInterval(() => this.flush(), options.flushMs ?? 500);
    this.timer.unref();
  }

  /** Redacts `secret` from everything written from now on. */
  addSecret(secret: string): void {
    if (secret.length >= 8) this.secrets = [...this.secrets, secret];
  }

  write(source: string, level: LogLevel, message: string): void {
    let text = message.replace(/\s+$/, '');
    for (const secret of this.secrets) text = text.split(secret).join('[redacted]');
    const time = new Date().toISOString();
    for (const line of text.split('\n')) {
      this.buffer.push(`${time} ${level.toUpperCase().padEnd(5)} [${source}] ${line}\n`);
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const chunk = this.buffer.join('');
    this.buffer = [];
    try {
      if (this.size > 0 && this.size + Buffer.byteLength(chunk) > this.maxBytes) {
        renameSync(this.file, this.previous);
        this.size = 0;
      }
      appendFileSync(this.file, chunk, { mode: 0o600 });
      this.size += Buffer.byteLength(chunk);
    } catch {
      // Nowhere left to report a logging failure; drop the lines.
    }
  }

  close(): void {
    clearInterval(this.timer);
    this.flush();
  }
}

/** Splits a stream of text into lines, calling `onLine` for each complete one. */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let pending = '';
  return (chunk) => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onLine(line);
  };
}

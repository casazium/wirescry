import type { ExchangeSummary, ServerMessage } from '../shared/api';

/**
 * Collects exchange changes and sends them in one message every `delayMs`, so a burst
 * of thousands of requests doesn't become thousands of WebSocket messages and renders.
 */
export class UpdateBatcher {
  private changed = new Map<string, ExchangeSummary>();
  private removed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly send: (message: Extract<ServerMessage, { type: 'exchanges' }>) => void,
    private readonly delayMs = 50,
  ) {}

  change(summary: ExchangeSummary): void {
    // Re-insert so the batch keeps first-seen order for new exchanges.
    this.changed.set(summary.id, summary);
    this.schedule();
  }

  remove(id: string): void {
    this.changed.delete(id);
    this.removed.add(id);
    this.schedule();
  }

  /** Drops anything not yet sent, e.g. after Clear. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.changed.clear();
    this.removed.clear();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.changed.size === 0 && this.removed.size === 0) return;
    const message = {
      type: 'exchanges' as const,
      exchanges: [...this.changed.values()],
      removed: [...this.removed],
    };
    this.changed = new Map();
    this.removed = new Set();
    this.send(message);
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => this.flush(), this.delayMs);
  }
}

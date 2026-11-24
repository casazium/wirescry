import type { ExchangeSummary, KnownPush, ServerMessage } from '../shared/api';

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
    /**
     * Known values for the window to have before these exchanges (see window-known.ts), learned
     * from them first; undefined when there are none to send.
     */
    private readonly knownFor?: (exchanges: readonly ExchangeSummary[]) => KnownPush | undefined,
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

  /** Sends what's waiting, and any known values to go with it, now. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const exchanges = [...this.changed.values()];
    const known = this.knownFor?.(exchanges);
    if (exchanges.length === 0 && this.removed.size === 0 && !known) return;
    // Values first, so the window has them before it shows the exchanges they came from.
    const message = {
      type: 'exchanges' as const,
      ...(known ? { known } : {}),
      exchanges,
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

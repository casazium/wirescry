import type { ExchangeDetail, ExchangeSummary } from '../shared/api';

/**
 * The captured exchanges, without their bodies (see BodyStore).
 * Kept behind an interface so storage can change without touching the proxy or the API.
 */
export interface UpsertOptions {
  /**
   * When full, keep exchanges still going and drop the oldest finished one (the default); false
   * drops the oldest whatever it is, e.g. for a HAR import, which says how many older ones went.
   */
  keepLive?: boolean;
}

export interface RequestStore {
  upsert(exchange: ExchangeDetail, options?: UpsertOptions): void;
  get(id: string): ExchangeDetail | undefined;
  list(): ExchangeSummary[];
  /** Returns whether there was such an exchange. */
  delete(id: string): boolean;
  clear(): void;
}

/**
 * True while an exchange is still going: no response yet, a response still arriving (a long
 * gRPC or Server-Sent Events stream), or a WebSocket still open.
 */
export function isLive(summary: ExchangeSummary): boolean {
  if (summary.failure || summary.imported) return false;
  // Set when the response has arrived in full, or the WebSocket has closed.
  return summary.durationMs === undefined && summary.closeCode === undefined;
}

/** How many of the oldest exchanges are passed over, at most, to keep live ones. */
export const LIVE_SCAN_LIMIT = 1000;

/**
 * Keeps the most recent exchanges in memory, dropping the oldest past `limit`. An exchange still
 * going is kept and the oldest finished one dropped instead, so a long stream that started early
 * doesn't vanish while it's open; past LIVE_SCAN_LIMIT live ones, the oldest goes regardless.
 */
export class InMemoryRequestStore implements RequestStore {
  private readonly exchanges = new Map<string, ExchangeDetail>();

  constructor(
    private readonly limit = 10_000,
    /** Called with the id of each exchange dropped to stay under the limit. */
    private readonly onEvict: (id: string) => void = () => undefined,
  ) {}

  upsert(exchange: ExchangeDetail, { keepLive = true }: UpsertOptions = {}): void {
    this.exchanges.set(exchange.summary.id, exchange);
    if (this.exchanges.size > this.limit) {
      const victim = keepLive ? this.oldestToDrop() : this.exchanges.keys().next().value;
      if (victim !== undefined) {
        this.exchanges.delete(victim);
        this.onEvict(victim);
      }
    }
  }

  /** The oldest finished exchange among the oldest LIVE_SCAN_LIMIT, else the oldest of all. */
  private oldestToDrop(): string | undefined {
    let oldest: string | undefined;
    let scanned = 0;
    for (const [id, exchange] of this.exchanges) {
      oldest ??= id;
      if (!isLive(exchange.summary)) return id;
      if (++scanned >= LIVE_SCAN_LIMIT) break;
    }
    return oldest;
  }

  get(id: string): ExchangeDetail | undefined {
    return this.exchanges.get(id);
  }

  list(): ExchangeSummary[] {
    return [...this.exchanges.values()].map((e) => e.summary);
  }

  delete(id: string): boolean {
    return this.exchanges.delete(id);
  }

  get size(): number {
    return this.exchanges.size;
  }

  clear(): void {
    this.exchanges.clear();
  }
}

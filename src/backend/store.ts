import type { ExchangeDetail, ExchangeSummary } from '../shared/api';

/**
 * The captured exchanges, without their bodies (see BodyStore).
 * Kept behind an interface so storage can change without touching the proxy or the API.
 */
export interface RequestStore {
  upsert(exchange: ExchangeDetail): void;
  get(id: string): ExchangeDetail | undefined;
  list(): ExchangeSummary[];
  clear(): void;
}

/** Keeps the most recent exchanges in memory, dropping the oldest past `limit`. */
export class InMemoryRequestStore implements RequestStore {
  private readonly exchanges = new Map<string, ExchangeDetail>();

  constructor(
    private readonly limit = 10_000,
    /** Called with the id of each exchange dropped to stay under the limit. */
    private readonly onEvict: (id: string) => void = () => undefined,
  ) {}

  upsert(exchange: ExchangeDetail): void {
    this.exchanges.set(exchange.summary.id, exchange);
    if (this.exchanges.size > this.limit) {
      const oldest = this.exchanges.keys().next().value;
      if (oldest !== undefined) {
        this.exchanges.delete(oldest);
        this.onEvict(oldest);
      }
    }
  }

  get(id: string): ExchangeDetail | undefined {
    return this.exchanges.get(id);
  }

  list(): ExchangeSummary[] {
    return [...this.exchanges.values()].map((e) => e.summary);
  }

  clear(): void {
    this.exchanges.clear();
  }
}

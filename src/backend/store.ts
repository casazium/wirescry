import type { ExchangeSummary } from '../shared/api';

/**
 * Where captured traffic lives. Kept behind an interface so large bodies can
 * move to disk later without touching the proxy or the API.
 */
export interface RequestStore {
  upsert(exchange: ExchangeSummary): void;
  get(id: string): ExchangeSummary | undefined;
  list(): ExchangeSummary[];
  clear(): void;
}

/** Keeps the most recent exchanges in memory, dropping the oldest past `limit`. */
export class InMemoryRequestStore implements RequestStore {
  private readonly exchanges = new Map<string, ExchangeSummary>();

  constructor(private readonly limit = 10_000) {}

  upsert(exchange: ExchangeSummary): void {
    this.exchanges.set(exchange.id, exchange);
    if (this.exchanges.size > this.limit) {
      const oldest = this.exchanges.keys().next().value;
      if (oldest !== undefined) this.exchanges.delete(oldest);
    }
  }

  get(id: string): ExchangeSummary | undefined {
    return this.exchanges.get(id);
  }

  list(): ExchangeSummary[] {
    return [...this.exchanges.values()];
  }

  clear(): void {
    this.exchanges.clear();
  }
}

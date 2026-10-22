import type { ExchangeSummary } from '../../shared/api';

/**
 * The live list of exchanges. Updates are applied in place, with an index for
 * fast lookup, instead of copying the whole list for every change.
 */
export class ExchangeList {
  private items: ExchangeSummary[] = [];
  private positions = new Map<string, number>();

  reset(items: ExchangeSummary[]): void {
    this.items = [...items];
    this.reindex();
  }

  apply(changed: ExchangeSummary[], removed: string[]): void {
    if (removed.length > 0) {
      const gone = new Set(removed);
      this.items = this.items.filter((e) => !gone.has(e.id));
      this.reindex();
    }
    for (const exchange of changed) {
      const index = this.positions.get(exchange.id);
      if (index === undefined) {
        this.positions.set(exchange.id, this.items.length);
        this.items.push(exchange);
      } else {
        this.items[index] = exchange;
      }
    }
  }

  /** A copy, safe to hand to React as state. */
  snapshot(): ExchangeSummary[] {
    return this.items.slice();
  }

  private reindex(): void {
    this.positions = new Map(this.items.map((e, i) => [e.id, i]));
  }
}

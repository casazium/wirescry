import type { WebSocketMessage } from '../shared/api';

export interface WebSocketStoreOptions {
  /** Bytes of content kept per message; the rest is counted but dropped. */
  maxMessageBytes?: number;
  /** Total bytes of content kept across all connections; the oldest messages go first. */
  maxTotalBytes?: number;
}

interface StoredMessage extends WebSocketMessage {
  content: Buffer;
}

interface Connection {
  messages: StoredMessage[];
  /** Messages dropped from the start of this connection to stay under the budget. */
  dropped: number;
  /** Index the next message gets. */
  next: number;
}

/**
 * WebSocket messages per connection, kept in memory within a byte budget. Each
 * message is numbered from 0 for its connection, so the UI can ask for the ones
 * after the last it has.
 */
export class WebSocketStore {
  private readonly connections = new Map<string, Connection>();
  /** All stored messages oldest first, for evicting across connections. */
  private readonly order: Array<{ id: string; message: StoredMessage }> = [];
  private orderStart = 0;
  private totalBytes = 0;
  private readonly maxMessageBytes: number;
  private readonly maxTotalBytes: number;

  constructor(options: WebSocketStoreOptions = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? 64 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
  }

  add(
    exchangeId: string,
    message: { fromClient: boolean; content: Uint8Array; isBinary: boolean; time: number },
  ): WebSocketMessage {
    let connection = this.connections.get(exchangeId);
    if (!connection) {
      connection = { messages: [], dropped: 0, next: 0 };
      this.connections.set(exchangeId, connection);
    }
    const kept = Buffer.from(message.content.subarray(0, this.maxMessageBytes));
    const stored: StoredMessage = {
      index: connection.next++,
      fromClient: message.fromClient,
      isBinary: message.isBinary,
      time: message.time,
      size: message.content.length,
      content: kept,
    };
    connection.messages.push(stored);
    this.order.push({ id: exchangeId, message: stored });
    this.totalBytes += kept.length;
    this.evict();
    return stored;
  }

  /** Messages after `afterIndex` (or from the start), up to `limit`, with their content. */
  get(
    exchangeId: string,
    afterIndex = -1,
    limit = 500,
  ): { messages: Array<WebSocketMessage & { base64: string }>; dropped: number; total: number } {
    const connection = this.connections.get(exchangeId);
    if (!connection) return { messages: [], dropped: 0, total: 0 };
    const messages = connection.messages
      .filter((m) => m.index > afterIndex)
      .slice(0, limit)
      .map(({ content, ...m }) => ({ ...m, base64: content.toString('base64') }));
    return { messages, dropped: connection.dropped, total: connection.next };
  }

  count(exchangeId: string): number {
    return this.connections.get(exchangeId)?.next ?? 0;
  }

  delete(exchangeId: string): void {
    const connection = this.connections.get(exchangeId);
    if (!connection) return;
    for (const m of connection.messages) this.totalBytes -= m.content.length;
    this.connections.delete(exchangeId);
    // Entries in `order` for this connection are skipped when evicting.
  }

  clear(): void {
    this.connections.clear();
    this.order.length = 0;
    this.orderStart = 0;
    this.totalBytes = 0;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  private evict(): void {
    while (this.totalBytes > this.maxTotalBytes && this.orderStart < this.order.length) {
      const { id, message } = this.order[this.orderStart++]!;
      const connection = this.connections.get(id);
      if (!connection || connection.messages[0] !== message) continue; // Already deleted.
      connection.messages.shift();
      connection.dropped++;
      this.totalBytes -= message.content.length;
    }
    // Compact the order list now and then, so it doesn't grow forever.
    if (this.orderStart > 10_000 && this.orderStart > this.order.length / 2) {
      this.order.splice(0, this.orderStart);
      this.orderStart = 0;
    }
  }
}

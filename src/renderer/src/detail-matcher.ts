/**
 * Keeps track of which exchanges match a search with header terms. Only the backend has the
 * headers, so it asks the backend: once for every exchange when the search changes (or the
 * connection starts over), then for just the ids in each batch of new or changed exchanges.
 *
 * Replies can come back in any order (the backend yields while it searches), so every request
 * gets a sequence number, and an answer about an exchange counts only if no later request has
 * asked about it. A full request asks about every exchange, so it overrides earlier batches'.
 *
 * What the list shows is the *applied* search: the latest one whose full answer has arrived.
 * Until a new search's answer arrives, the previous one stays in force.
 */

/** A big batch (e.g. a HAR import) costs less as one full search than as a long list of ids. */
export const MAX_BATCH_IDS = 2000;

export interface DetailMatchState {
  /** The search the set belongs to, once its first full answer has arrived. */
  applied?: string;
  /** Exchanges that match the applied search. Exchanges not yet answered for aren't in it. */
  matches: ReadonlySet<string>;
  /** Changes whenever `applied`, `matches` or `error` does. */
  version: number;
  /** Why the backend couldn't answer the applied search, if it couldn't. */
  error?: string;
  /**
   * True while a search is being asked afresh and isn't answered yet: a new one, or the same
   * one again after the connection started over. The applied one stays shown meanwhile.
   */
  pending: boolean;
}

/** Lost with the connection: the next connection asks again in full. */
const DISCONNECTED = new Set(['Disconnected', 'Not connected']);

/** Asks the backend which of `ids` (or of all exchanges) match `query`. */
export type Ask = (query: string, ids?: string[]) => Promise<string[]>;

interface Search {
  generation: number;
  query: string;
  matches: Set<string>;
  /** The latest request that asked about each id. */
  lastAsked: Map<string, number>;
  /** The latest full request. */
  full: number;
  /** True from sending a full request until its answer. */
  awaitingFull: boolean;
  /**
   * Removed while a full request is unanswered: its answer may still list them. `all` when
   * everything was cleared.
   */
  goneSince: Set<string> | 'all';
  ready: boolean;
  error?: string;
}

export class DetailMatcher {
  private generation = 0;
  private seq = 0;
  private current: Search | undefined;
  private applied: Search | undefined;
  private version = 0;
  private connection: Ask | undefined;

  constructor(private readonly onChange: (state: DetailMatchState) => void) {}

  /** The connection to ask through, or undefined while there's none. */
  connect(ask: Ask | undefined): void {
    this.connection = ask;
  }

  private ask(query: string, ids?: string[]): Promise<string[]> {
    return this.connection ? this.connection(query, ids) : Promise.reject(new Error('Not connected'));
  }

  state(): DetailMatchState {
    return {
      applied: this.applied?.query,
      matches: this.applied?.matches ?? new Set(),
      version: this.version,
      ...(this.applied?.error ? { error: this.applied.error } : {}),
      pending: this.current !== undefined && this.current !== this.applied,
    };
  }

  /** The search box's text when it has header terms; undefined when it has none. */
  setQuery(query: string | undefined): void {
    if (query === this.current?.query) return;
    this.generation++;
    if (query === undefined) {
      this.current = undefined;
      if (this.applied) {
        this.applied = undefined;
        this.changed();
      }
      return;
    }
    this.current = this.newSearch(query);
    this.askAll();
    if (this.applied) this.changed();
  }

  /** A new connection (the backend restarted, or the same one reconnected): ask again from scratch. */
  restart(): void {
    if (!this.current) return;
    this.generation++;
    this.current = this.newSearch(this.current.query);
    this.askAll();
    // Now pending: say so.
    if (this.applied) this.changed();
  }

  /** A batch from the backend: new or changed exchanges, and those removed. */
  onBatch(changed: readonly string[], removed: readonly string[]): void {
    const search = this.current;
    if (!search) return;
    if (removed.length > 0) {
      for (const id of removed) {
        search.matches.delete(id);
        search.lastAsked.delete(id);
        if (search.awaitingFull && search.goneSince !== 'all') search.goneSince.add(id);
        this.applied?.matches.delete(id);
      }
      if (this.applied) this.changed();
    }
    if (changed.length === 0) return;
    if (changed.length > MAX_BATCH_IDS) {
      this.askAll();
      return;
    }
    const seq = ++this.seq;
    const ids = [...changed];
    for (const id of ids) search.lastAsked.set(id, seq);
    this.ask(search.query, ids).then(
      (matched) => this.onAnswer(search, seq, ids, matched),
      // Lost with the connection; the next one asks again in full.
      () => undefined,
    );
  }

  /** Everything was cleared. */
  clear(): void {
    for (const search of [this.current, this.applied]) {
      search?.matches.clear();
      search?.lastAsked.clear();
    }
    if (this.current?.awaitingFull) this.current.goneSince = 'all';
    if (this.applied) this.changed();
  }

  private newSearch(query: string): Search {
    return {
      generation: this.generation,
      query,
      matches: new Set(),
      lastAsked: new Map(),
      full: 0,
      awaitingFull: false,
      goneSince: new Set(),
      ready: false,
    };
  }

  private askAll(): void {
    const search = this.current;
    if (!search) return;
    const seq = ++this.seq;
    search.full = seq;
    search.awaitingFull = true;
    search.goneSince = new Set();
    this.ask(search.query).then(
      (matched) => this.onFullAnswer(search, seq, matched),
      (error: unknown) => this.onFullError(search, seq, error),
    );
  }

  private onFullAnswer(search: Search, seq: number, matched: string[]): void {
    if (search !== this.current || seq !== search.full) return;
    const next = new Set<string>();
    // Exchanges asked about since: their own answer decides (it may already have come).
    for (const id of search.matches) if ((search.lastAsked.get(id) ?? 0) > seq) next.add(id);
    const gone = search.goneSince;
    // Answered for what the store held then; leave out what has gone since (all, after a Clear).
    if (gone !== 'all') {
      for (const id of matched) if ((search.lastAsked.get(id) ?? 0) <= seq && !gone.has(id)) next.add(id);
    }
    search.matches = next;
    search.awaitingFull = false;
    search.goneSince = new Set();
    search.error = undefined;
    search.ready = true;
    this.applied = search;
    this.changed();
  }

  /** The backend refused the search: show that, with nothing matching, rather than wait for ever. */
  private onFullError(search: Search, seq: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (search !== this.current || seq !== search.full || DISCONNECTED.has(message)) return;
    search.matches = new Set();
    search.awaitingFull = false;
    search.goneSince = new Set();
    search.error = message;
    search.ready = true;
    this.applied = search;
    this.changed();
  }

  private onAnswer(search: Search, seq: number, asked: string[], matched: string[]): void {
    // A full request sent since asked about every exchange: its answer decides.
    // After a refusal, only a full answer counts: no rows beside the error.
    if (search !== this.current || seq < search.full || search.error) return;
    const hits = new Set(matched);
    let any = false;
    for (const id of asked) {
      if (search.lastAsked.get(id) !== seq) continue;
      any = true;
      if (hits.has(id)) search.matches.add(id);
      else search.matches.delete(id);
    }
    if (any && search.ready) this.changed();
  }

  private changed(): void {
    this.version++;
    this.onChange(this.state());
  }
}

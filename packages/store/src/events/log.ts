import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../sqlite/types';
import { GENESIS_HASH, hashEntry, hashPayload, sha256Hex } from './hash';
import { canonicalJson, parseJson, type JsonValue } from './json';

export interface AppendEventInput {
  readonly type: string;
  readonly payload: JsonValue;
  /** Null for app-level events that belong to no research session. */
  readonly sessionId?: string | null;
  /** Supplied only when replaying or importing a log. */
  readonly eventId?: string;
  readonly recordedAt?: string;
}

export interface EventRecord {
  readonly seq: number;
  readonly eventId: string;
  readonly sessionId: string | null;
  readonly type: string;
  readonly payload: JsonValue;
  readonly recordedAt: string;
  readonly payloadHash: string;
  readonly prevHash: string;
  readonly entryHash: string;
}

export interface ReadEventsOptions {
  /** Inclusive lower bound on `seq`. */
  readonly fromSeq?: number;
  readonly limit?: number;
  readonly sessionId?: string | null;
  readonly type?: string;
}

export interface ChainHead {
  readonly seq: number;
  readonly entryHash: string;
}

export type ChainFailureReason =
  | 'payload-hash'
  | 'entry-hash'
  | 'broken-link'
  | 'sequence-gap'
  | 'unreadable-payload'
  | 'head-mismatch';

export interface ChainFailure {
  readonly seq: number;
  readonly eventId: string;
  readonly reason: ChainFailureReason;
  readonly detail: string;
}

export interface ChainVerification {
  readonly ok: boolean;
  readonly checked: number;
  readonly head?: ChainHead;
  readonly failures: readonly ChainFailure[];
}

export class EventLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventLogError';
  }
}

/** A type alias, not an interface: `SqlRow` needs an implicit index signature. */
type EventRow = {
  seq: number;
  event_id: string;
  session_id: string | null;
  type: string;
  payload: string;
  recorded_at: string;
  payload_hash: string;
  prev_hash: string;
  entry_hash: string;
};

const SELECT_COLUMNS =
  'seq, event_id, session_id, type, payload, recorded_at, payload_hash, prev_hash, entry_hash';

/** Where the head anchor lives, so a truncated log is detectable. */
export const HEAD_ANCHOR_KEY = 'event_log_head';

export interface EventLogOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Rows fetched per batch by the streaming reader and the verifier. */
  readonly batchSize?: number;
}

/**
 * Append-only, hash-chained event log.
 *
 * Every entry hashes its own payload and its position in the chain, including
 * the previous entry's hash. Editing, reordering or deleting any row breaks
 * verification from that point on, which is what makes the log — rather than
 * any table derived from it — the thing worth trusting.
 *
 * A hash chain cannot notice that entries were removed from the *end*, so the
 * head is also anchored in `app_meta` and compared during verification.
 *
 * Sheep holds a single-instance lock, so one process owns this log. A racing
 * writer would collide on the `seq` primary key and fail loudly rather than
 * fork the chain.
 */
export class EventLog {
  readonly #db: SqliteDatabase;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #batchSize: number;

  constructor(db: SqliteDatabase, options: EventLogOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => randomUUID());
    this.#batchSize = options.batchSize ?? 500;
  }

  /** The last entry, or undefined for an empty log. */
  head(): ChainHead | undefined {
    const row = this.#db.get<{ seq: number; entry_hash: string }>(
      'SELECT seq, entry_hash FROM events ORDER BY seq DESC LIMIT 1',
    );
    return row ? { seq: row.seq, entryHash: row.entry_hash } : undefined;
  }

  /** The head recorded at append time, independent of the events table. */
  anchor(): ChainHead | undefined {
    const row = this.#db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', [
      HEAD_ANCHOR_KEY,
    ]);
    if (!row) return undefined;
    const parsed = parseJson(row.value) as { seq?: number; entryHash?: string };
    return typeof parsed.seq === 'number' && typeof parsed.entryHash === 'string'
      ? { seq: parsed.seq, entryHash: parsed.entryHash }
      : undefined;
  }

  count(): number {
    return this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events')?.n ?? 0;
  }

  append(input: AppendEventInput): EventRecord {
    return this.appendAll([input])[0]!;
  }

  /** Appends a batch atomically: either the whole batch lands or none of it. */
  appendAll(inputs: readonly AppendEventInput[]): EventRecord[] {
    if (inputs.length === 0) return [];

    return this.#db.transaction(() => {
      let previous = this.head();
      const written: EventRecord[] = [];

      for (const input of inputs) {
        if (input.type.trim() === '') throw new EventLogError('event type must not be empty');

        const seq = (previous?.seq ?? 0) + 1;
        const prevHash = previous?.entryHash ?? GENESIS_HASH;
        const eventId = input.eventId ?? this.#newId();
        const sessionId = input.sessionId ?? null;
        const recordedAt = input.recordedAt ?? this.#now().toISOString();
        const payloadText = canonicalJson(input.payload);
        const payloadHash = hashPayload(input.payload);
        const entryHash = hashEntry({
          seq,
          eventId,
          sessionId,
          type: input.type,
          recordedAt,
          payloadHash,
          prevHash,
        });

        this.#db.run(`INSERT INTO events (${SELECT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          seq,
          eventId,
          sessionId,
          input.type,
          payloadText,
          recordedAt,
          payloadHash,
          prevHash,
          entryHash,
        ]);

        written.push({
          seq,
          eventId,
          sessionId,
          type: input.type,
          payload: input.payload,
          recordedAt,
          payloadHash,
          prevHash,
          entryHash,
        });
        previous = { seq, entryHash };
      }

      if (previous) this.#writeAnchor(previous);
      return written;
    });
  }

  /** Reads entries in chain order. */
  read(options: ReadEventsOptions = {}): EventRecord[] {
    return this.#readRows(options).map(toRecord);
  }

  /**
   * Sequential reader: yields the whole log in order without holding it all in
   * memory, which is what replay and export need.
   */
  *stream(options: ReadEventsOptions = {}): Generator<EventRecord> {
    for (const row of this.#streamRows(options)) yield toRecord(row);
  }

  /**
   * Recomputes every hash and every link, and checks the head against its
   * anchor. Returns every failure rather than throwing on the first, so a
   * damaged log can be inspected rather than merely refused.
   */
  verify(options: { fromSeq?: number } = {}): ChainVerification {
    const failures: ChainFailure[] = [];
    let checked = 0;
    let expectedSeq = options.fromSeq ?? 1;
    let previousHash = expectedSeq === 1 ? GENESIS_HASH : undefined;
    let head: ChainHead | undefined;

    for (const row of this.#streamRows({ fromSeq: expectedSeq })) {
      checked += 1;
      const fail = (reason: ChainFailureReason, detail: string): void => {
        failures.push({ seq: row.seq, eventId: row.event_id, reason, detail });
      };

      if (row.seq !== expectedSeq) {
        fail('sequence-gap', `expected seq ${String(expectedSeq)}, found ${String(row.seq)}`);
        expectedSeq = row.seq;
      }

      // The stored text is canonical JSON, so hashing it directly catches any
      // byte-level edit — including ones a lenient JSON parser would forgive.
      const payloadHash = sha256Hex(row.payload);
      if (payloadHash !== row.payload_hash) {
        fail(
          'payload-hash',
          `stored ${row.payload_hash.slice(0, 12)}…, computed ${payloadHash.slice(0, 12)}…`,
        );
      }

      try {
        parseJson(row.payload);
      } catch (error) {
        fail('unreadable-payload', error instanceof Error ? error.message : String(error));
      }

      if (previousHash !== undefined && row.prev_hash !== previousHash) {
        fail(
          'broken-link',
          `prev_hash ${row.prev_hash.slice(0, 12)}… does not match the previous entry ${previousHash.slice(0, 12)}…`,
        );
      }

      const entryHash = hashEntry({
        seq: row.seq,
        eventId: row.event_id,
        sessionId: row.session_id,
        type: row.type,
        recordedAt: row.recorded_at,
        payloadHash: row.payload_hash,
        prevHash: row.prev_hash,
      });
      if (entryHash !== row.entry_hash) {
        fail(
          'entry-hash',
          `stored ${row.entry_hash.slice(0, 12)}…, computed ${entryHash.slice(0, 12)}…`,
        );
      }

      previousHash = row.entry_hash;
      head = { seq: row.seq, entryHash: row.entry_hash };
      expectedSeq += 1;
    }

    const anchor = this.anchor();
    if (anchor && (head?.seq !== anchor.seq || head.entryHash !== anchor.entryHash)) {
      failures.push({
        seq: anchor.seq,
        eventId: '',
        reason: 'head-mismatch',
        detail: head
          ? `log ends at seq ${String(head.seq)} (${head.entryHash.slice(0, 12)}…) but the anchor records seq ${String(anchor.seq)} (${anchor.entryHash.slice(0, 12)}…)`
          : `log is empty but the anchor records seq ${String(anchor.seq)}`,
      });
    }

    return head === undefined
      ? { ok: failures.length === 0, checked, failures }
      : { ok: failures.length === 0, checked, head, failures };
  }

  #writeAnchor(head: ChainHead): void {
    this.#db.run(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [HEAD_ANCHOR_KEY, canonicalJson({ seq: head.seq, entryHash: head.entryHash })],
    );
  }

  #readRows(options: ReadEventsOptions = {}): EventRow[] {
    const conditions: string[] = ['seq >= ?'];
    const params: (string | number)[] = [options.fromSeq ?? 1];

    if (options.sessionId !== undefined) {
      if (options.sessionId === null) {
        conditions.push('session_id IS NULL');
      } else {
        conditions.push('session_id = ?');
        params.push(options.sessionId);
      }
    }
    if (options.type !== undefined) {
      conditions.push('type = ?');
      params.push(options.type);
    }

    let sql = `SELECT ${SELECT_COLUMNS} FROM events WHERE ${conditions.join(' AND ')} ORDER BY seq`;
    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    return this.#db.all<EventRow>(sql, params);
  }

  *#streamRows(options: ReadEventsOptions = {}): Generator<EventRow> {
    let cursor = options.fromSeq ?? 1;
    let remaining = options.limit ?? Number.POSITIVE_INFINITY;

    while (remaining > 0) {
      const batch = this.#readRows({
        ...options,
        fromSeq: cursor,
        limit: Math.min(this.#batchSize, remaining),
      });
      if (batch.length === 0) return;

      for (const row of batch) yield row;

      remaining -= batch.length;
      cursor = batch[batch.length - 1]!.seq + 1;
    }
  }
}

function toRecord(row: EventRow): EventRecord {
  return {
    seq: row.seq,
    eventId: row.event_id,
    sessionId: row.session_id,
    type: row.type,
    payload: parseJson(row.payload),
    recordedAt: row.recorded_at,
    payloadHash: row.payload_hash,
    prevHash: row.prev_hash,
    entryHash: row.entry_hash,
  };
}

import type { DomainEvent, DomainEventType, Message, SessionSummary } from '@sheep/core';
import type { EventRecord } from '../events/log';
import type { SqliteDatabase } from '../sqlite/types';
import type { Projection } from './types';

/**
 * Tables derived from the log by `SESSIONS_PROJECTION`.
 *
 * `IF NOT EXISTS` throughout, because this DDL is also what recreates the
 * tables after they have been dropped — which is the property that proves the
 * log, and not these rows, is the record of what happened.
 */
export const SESSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id       TEXT PRIMARY KEY,
    title            TEXT NOT NULL,
    question         TEXT NOT NULL,
    status           TEXT NOT NULL,
    budget_cap_usd   REAL,
    budget_spent_usd REAL NOT NULL,
    message_count    INTEGER NOT NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS messages (
    message_id     TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL,
    phase_id       TEXT,
    round_id       TEXT,
    -- The log sequence that produced this row: the only ordering that is
    -- guaranteed total, since two messages can share a timestamp.
    seq            INTEGER NOT NULL,
    author_kind    TEXT NOT NULL,
    participant_id TEXT,
    connection_id  TEXT,
    vendor_id      TEXT,
    model_id       TEXT,
    model_version  TEXT,
    role           TEXT,
    body_kind      TEXT NOT NULL,
    body_text      TEXT,
    body_hash      TEXT,
    body_bytes     INTEGER,
    media_type     TEXT,
    input_tokens   INTEGER,
    output_tokens  INTEGER,
    cached_tokens  INTEGER,
    cost_usd       REAL,
    prompt_hash    TEXT,
    recorded_at    TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS messages_session_seq_idx ON messages (session_id, seq);
`;

const HANDLED = new Set<DomainEventType>([
  'session.created',
  'session.retitled',
  'session.question-revised',
  'session.status-changed',
  'session.budget-set',
  'session.spend-recorded',
  'message.recorded',
]);

/**
 * `sessions` and `messages`, folded out of the event log.
 *
 * Every statement here is written to be safe to run twice, because a rebuild
 * replays events the tables may already reflect. The one exception is spend,
 * which accumulates — and that is exactly why `rebuild()` empties the tables
 * before replaying rather than replaying over them.
 *
 * Spend has a single source: `session.spend-recorded`. A message's own
 * `usage.costUsd` is provenance for that one call and is stored on the message
 * row, but it never moves the session counter, so the two can never
 * double-count each other.
 */
export const SESSIONS_PROJECTION: Projection = {
  name: 'sessions',
  ddlVersion: 1,
  // Child first: `messages` is the table a future foreign key would depend on.
  tables: ['messages', 'sessions'],
  ddl: SESSIONS_DDL,

  handles(type: DomainEventType): boolean {
    return HANDLED.has(type);
  },

  apply(db: SqliteDatabase, event: DomainEvent, record: EventRecord): void {
    const at = record.recordedAt;

    switch (event.type) {
      case 'session.created': {
        db.run(
          `INSERT INTO sessions (
             session_id, title, question, status, budget_cap_usd, budget_spent_usd,
             message_count, created_at, updated_at
           ) VALUES (?, ?, ?, 'draft', NULL, 0, 0, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             title = excluded.title,
             question = excluded.question,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at`,
          [event.payload.sessionId, event.payload.title, event.payload.question, at, at],
        );
        return;
      }

      case 'session.retitled': {
        db.run('UPDATE sessions SET title = ?, updated_at = ? WHERE session_id = ?', [
          event.payload.title,
          at,
          event.payload.sessionId,
        ]);
        return;
      }

      case 'session.question-revised': {
        db.run('UPDATE sessions SET question = ?, updated_at = ? WHERE session_id = ?', [
          event.payload.question,
          at,
          event.payload.sessionId,
        ]);
        return;
      }

      case 'session.status-changed': {
        db.run('UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?', [
          event.payload.status,
          at,
          event.payload.sessionId,
        ]);
        return;
      }

      case 'session.budget-set': {
        db.run('UPDATE sessions SET budget_cap_usd = ?, updated_at = ? WHERE session_id = ?', [
          event.payload.capUsd,
          at,
          event.payload.sessionId,
        ]);
        return;
      }

      case 'session.spend-recorded': {
        db.run(
          `UPDATE sessions
             SET budget_spent_usd = budget_spent_usd + ?, updated_at = ?
           WHERE session_id = ?`,
          [event.payload.costUsd, at, event.payload.sessionId],
        );
        return;
      }

      case 'message.recorded': {
        const { author, body, usage } = event.payload;
        db.run(
          `INSERT INTO messages (
             message_id, session_id, phase_id, round_id, seq, author_kind, participant_id,
             connection_id, vendor_id, model_id, model_version, role, body_kind, body_text,
             body_hash, body_bytes, media_type, input_tokens, output_tokens, cached_tokens,
             cost_usd, prompt_hash, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(message_id) DO UPDATE SET
             seq = excluded.seq,
             recorded_at = excluded.recorded_at`,
          [
            event.payload.messageId,
            event.payload.sessionId,
            event.payload.phaseId ?? null,
            event.payload.roundId ?? null,
            record.seq,
            author.kind,
            author.kind === 'MODEL' ? author.participantId : null,
            author.kind === 'MODEL' ? author.model.connectionId : null,
            author.kind === 'MODEL' ? author.model.vendorId : null,
            author.kind === 'MODEL' ? author.model.modelId : null,
            author.kind === 'MODEL' ? (author.model.version ?? null) : null,
            event.payload.role ?? null,
            body.kind,
            body.kind === 'text' ? body.text : null,
            body.kind === 'blob' ? body.hash : null,
            body.kind === 'blob' ? body.bytes : null,
            body.kind === 'blob' ? body.mediaType : null,
            usage?.inputTokens ?? null,
            usage?.outputTokens ?? null,
            usage?.cachedInputTokens ?? null,
            usage?.costUsd ?? null,
            event.payload.promptHash ?? null,
            at,
          ],
        );

        // Recomputed rather than incremented, so it is right whether this event
        // is being seen for the first time or replayed over an existing row.
        db.run(
          `UPDATE sessions
             SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?),
                 updated_at = ?
           WHERE session_id = ?`,
          [event.payload.sessionId, at, event.payload.sessionId],
        );
        return;
      }

      default: {
        throw new Error(
          `sessions projection was handed an event it does not handle: ${event.type}`,
        );
      }
    }
  },
};

type SessionRow = {
  session_id: string;
  title: string;
  question: string;
  status: string;
  budget_cap_usd: number | null;
  budget_spent_usd: number;
  message_count: number;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  message_id: string;
  session_id: string;
  phase_id: string | null;
  round_id: string | null;
  seq: number;
  author_kind: string;
  participant_id: string | null;
  connection_id: string | null;
  vendor_id: string | null;
  model_id: string | null;
  model_version: string | null;
  role: string | null;
  body_kind: string;
  body_text: string | null;
  body_hash: string | null;
  body_bytes: number | null;
  media_type: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost_usd: number | null;
  prompt_hash: string | null;
  recorded_at: string;
};

export type { SessionSummary };

const SESSION_COLUMNS =
  'session_id, title, question, status, budget_cap_usd, budget_spent_usd, message_count, created_at, updated_at';

const MESSAGE_COLUMNS =
  'message_id, session_id, phase_id, round_id, seq, author_kind, participant_id, connection_id, ' +
  'vendor_id, model_id, model_version, role, body_kind, body_text, body_hash, body_bytes, ' +
  'media_type, input_tokens, output_tokens, cached_tokens, cost_usd, prompt_hash, recorded_at';

/** Newest first — what a session list shows. */
export function listSessions(db: SqliteDatabase, limit = 100): SessionSummary[] {
  return db
    .all<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY created_at DESC, session_id LIMIT ?`,
      [limit],
    )
    .map(toSessionSummary);
}

export function getSession(db: SqliteDatabase, sessionId: string): SessionSummary | undefined {
  const row = db.get<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`, [
    sessionId,
  ]);
  return row ? toSessionSummary(row) : undefined;
}

export function countSessions(db: SqliteDatabase): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')?.n ?? 0;
}

/** In log order, which is the only total order two messages are guaranteed. */
export function listMessages(
  db: SqliteDatabase,
  sessionId: string,
  options: { limit?: number; fromSeq?: number } = {},
): Message[] {
  return db
    .all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE session_id = ? AND seq >= ? ORDER BY seq LIMIT ?`,
      [sessionId, options.fromSeq ?? 0, options.limit ?? 500],
    )
    .map(toMessage);
}

function toSessionSummary(row: SessionRow): SessionSummary {
  return {
    sessionId: row.session_id,
    title: row.title,
    question: row.question,
    // The column is TEXT; the domain enum is the authority on what is legal, and
    // a value that is not one is a projector bug rather than a user problem.
    status: row.status as SessionSummary['status'],
    budget: { capUsd: row.budget_cap_usd, spentUsd: row.budget_spent_usd },
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    messageId: row.message_id,
    sessionId: row.session_id,
    phaseId: row.phase_id,
    roundId: row.round_id,
    author: toAuthor(row),
    role: row.role as Message['role'],
    body:
      row.body_kind === 'blob'
        ? {
            kind: 'blob',
            hash: row.body_hash ?? '',
            bytes: row.body_bytes ?? 0,
            mediaType: row.media_type ?? 'application/octet-stream',
          }
        : { kind: 'text', text: row.body_text ?? '' },
    usage:
      row.cost_usd === null
        ? null
        : {
            inputTokens: row.input_tokens ?? 0,
            outputTokens: row.output_tokens ?? 0,
            ...(row.cached_tokens === null ? {} : { cachedInputTokens: row.cached_tokens }),
            costUsd: row.cost_usd,
          },
    promptHash: row.prompt_hash,
    recordedAt: row.recorded_at,
  };
}

function toAuthor(row: MessageRow): Message['author'] {
  if (row.author_kind !== 'MODEL') {
    return { kind: row.author_kind === 'HUMAN' ? 'HUMAN' : 'SYSTEM' };
  }
  return {
    kind: 'MODEL',
    participantId: row.participant_id ?? '',
    model: {
      connectionId: row.connection_id ?? '',
      vendorId: row.vendor_id ?? '',
      modelId: row.model_id ?? '',
      ...(row.model_version === null ? {} : { version: row.model_version }),
    },
  };
}

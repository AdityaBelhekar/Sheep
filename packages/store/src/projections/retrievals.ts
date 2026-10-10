import {
  retrievalRecordSchema,
  sourceRecordSchema,
  type DomainEvent,
  type DomainEventType,
  type RetrievalRecord,
  type SourceRecord,
} from '@sheep/core';
import type { EventRecord } from '../events/log';
import type { SqliteDatabase } from '../sqlite/types';
import type { Projection } from './types';

/**
 * Literature searches and the sources they found, folded out of
 * `retrieval.recorded`.
 *
 * Two tables from one event: a search is listed as a search, and each source
 * in it is a row of its own, because a source is what a claim cites and has to
 * be found by its own id.
 */
export const RETRIEVALS_DDL = `
  CREATE TABLE IF NOT EXISTS retrievals (
    retrieval_id TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    record       TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS retrievals_session_seq_idx ON retrievals (session_id, seq);

  CREATE TABLE IF NOT EXISTS sources (
    source_id    TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    retrieval_id TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    position     INTEGER NOT NULL,
    record       TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS sources_session_seq_idx ON sources (session_id, seq, position);
`;

export const RETRIEVALS_PROJECTION: Projection = {
  name: 'retrievals',
  ddlVersion: 1,
  tables: ['sources', 'retrievals'],
  ddl: RETRIEVALS_DDL,

  handles(type: DomainEventType): boolean {
    return type === 'retrieval.recorded';
  },

  apply(db: SqliteDatabase, event: DomainEvent, record: EventRecord): void {
    if (event.type !== 'retrieval.recorded') return;
    const row: RetrievalRecord = { ...event.payload, recordedAt: record.recordedAt };
    // OR REPLACE: a rebuild replays events the tables may already reflect.
    db.run(
      'INSERT OR REPLACE INTO retrievals (retrieval_id, session_id, seq, record) VALUES (?, ?, ?, ?)',
      [row.retrievalId, row.sessionId, record.seq, JSON.stringify(row)],
    );
    row.sources.forEach((source, position) => {
      const listed: SourceRecord = {
        ...source,
        sessionId: row.sessionId,
        retrievalId: row.retrievalId,
        recordedAt: record.recordedAt,
      };
      db.run(
        `INSERT OR REPLACE INTO sources (source_id, session_id, retrieval_id, seq, position, record)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          source.sourceId,
          row.sessionId,
          row.retrievalId,
          record.seq,
          position,
          JSON.stringify(listed),
        ],
      );
    });
  },
};

type Row = { record: string };

/** A session's searches, newest first. */
export function listRetrievals(db: SqliteDatabase, sessionId: string): RetrievalRecord[] {
  return db
    .all<Row>('SELECT record FROM retrievals WHERE session_id = ? ORDER BY seq DESC', [sessionId])
    .map((row) => retrievalRecordSchema.parse(JSON.parse(row.record)));
}

/** Every source a session has retrieved: newest search first, in the provider's order within it. */
export function listSources(db: SqliteDatabase, sessionId: string): SourceRecord[] {
  return db
    .all<Row>('SELECT record FROM sources WHERE session_id = ? ORDER BY seq DESC, position', [
      sessionId,
    ])
    .map((row) => sourceRecordSchema.parse(JSON.parse(row.record)));
}

export function getSource(db: SqliteDatabase, sourceId: string): SourceRecord | undefined {
  const row = db.get<Row>('SELECT record FROM sources WHERE source_id = ?', [sourceId]);
  return row ? sourceRecordSchema.parse(JSON.parse(row.record)) : undefined;
}

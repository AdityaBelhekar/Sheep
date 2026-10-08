import {
  executionRecordSchema,
  type DomainEvent,
  type DomainEventType,
  type ExecutionRecord,
} from '@sheep/core';
import type { EventRecord } from '../events/log';
import type { SqliteDatabase } from '../sqlite/types';
import type { Projection } from './types';

/**
 * Sandbox runs, one row each, folded out of `execution.recorded`.
 *
 * The record is kept whole as JSON rather than spread over columns: nothing
 * queries inside it, and a row that is the event's own shape cannot drift from
 * it. The columns beside it are the ones something looks up or orders by.
 */
export const EXECUTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS executions (
    execution_id TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    record       TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS executions_session_seq_idx ON executions (session_id, seq);
`;

export const EXECUTIONS_PROJECTION: Projection = {
  name: 'executions',
  ddlVersion: 1,
  tables: ['executions'],
  ddl: EXECUTIONS_DDL,

  handles(type: DomainEventType): boolean {
    return type === 'execution.recorded';
  },

  apply(db: SqliteDatabase, event: DomainEvent, record: EventRecord): void {
    if (event.type !== 'execution.recorded') return;
    const { peakMemoryBytes, ...fields } = event.payload;
    const row: ExecutionRecord = {
      ...fields,
      peakMemoryBytes: peakMemoryBytes ?? null,
      recordedAt: record.recordedAt,
    };
    // OR REPLACE: a rebuild replays events the table may already reflect.
    db.run(
      'INSERT OR REPLACE INTO executions (execution_id, session_id, seq, record) VALUES (?, ?, ?, ?)',
      [row.executionId, row.sessionId, record.seq, JSON.stringify(row)],
    );
  },
};

type ExecutionRow = { record: string };

const toRecord = (row: ExecutionRow): ExecutionRecord =>
  executionRecordSchema.parse(JSON.parse(row.record));

/** A session's runs, newest first. */
export function listExecutions(db: SqliteDatabase, sessionId: string): ExecutionRecord[] {
  return db
    .all<ExecutionRow>('SELECT record FROM executions WHERE session_id = ? ORDER BY seq DESC', [
      sessionId,
    ])
    .map(toRecord);
}

export function getExecution(db: SqliteDatabase, executionId: string): ExecutionRecord | undefined {
  const row = db.get<ExecutionRow>('SELECT record FROM executions WHERE execution_id = ?', [
    executionId,
  ]);
  return row ? toRecord(row) : undefined;
}

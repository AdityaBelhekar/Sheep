import {
  derivationRecordSchema,
  type DerivationRecord,
  type DomainEvent,
  type DomainEventType,
} from '@sheep/core';
import type { EventRecord } from '../events/log';
import type { SqliteDatabase } from '../sqlite/types';
import type { Projection } from './types';

/** Checked derivations, one row each, folded out of `derivation.recorded`. */
export const DERIVATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS derivations (
    derivation_id TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    record        TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS derivations_session_seq_idx ON derivations (session_id, seq);
`;

export const DERIVATIONS_PROJECTION: Projection = {
  name: 'derivations',
  ddlVersion: 1,
  tables: ['derivations'],
  ddl: DERIVATIONS_DDL,

  handles(type: DomainEventType): boolean {
    return type === 'derivation.recorded';
  },

  apply(db: SqliteDatabase, event: DomainEvent, record: EventRecord): void {
    if (event.type !== 'derivation.recorded') return;
    const { title, ...fields } = event.payload;
    const row: DerivationRecord = {
      ...fields,
      title: title ?? null,
      recordedAt: record.recordedAt,
    };
    // OR REPLACE: a rebuild replays events the table may already reflect.
    db.run(
      'INSERT OR REPLACE INTO derivations (derivation_id, session_id, seq, record) VALUES (?, ?, ?, ?)',
      [row.derivationId, row.sessionId, record.seq, JSON.stringify(row)],
    );
  },
};

type DerivationRow = { record: string };

const toRecord = (row: DerivationRow): DerivationRecord =>
  derivationRecordSchema.parse(JSON.parse(row.record));

/** A session's derivations, newest first. */
export function listDerivations(db: SqliteDatabase, sessionId: string): DerivationRecord[] {
  return db
    .all<DerivationRow>('SELECT record FROM derivations WHERE session_id = ? ORDER BY seq DESC', [
      sessionId,
    ])
    .map(toRecord);
}

export function getDerivation(
  db: SqliteDatabase,
  derivationId: string,
): DerivationRecord | undefined {
  const row = db.get<DerivationRow>('SELECT record FROM derivations WHERE derivation_id = ?', [
    derivationId,
  ]);
  return row ? toRecord(row) : undefined;
}

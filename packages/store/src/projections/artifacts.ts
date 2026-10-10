import {
  artifactRecordSchema,
  type ArtifactRecord,
  type DomainEvent,
  type DomainEventType,
} from '@sheep/core';
import type { EventRecord } from '../events/log';
import type { SqliteDatabase } from '../sqlite/types';
import type { Projection } from './types';

/** Rendered artifacts, one row each, folded out of `artifact.recorded`. */
export const ARTIFACTS_DDL = `
  CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    record      TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS artifacts_session_seq_idx ON artifacts (session_id, seq);
`;

export const ARTIFACTS_PROJECTION: Projection = {
  name: 'artifacts',
  ddlVersion: 1,
  tables: ['artifacts'],
  ddl: ARTIFACTS_DDL,

  handles(type: DomainEventType): boolean {
    return type === 'artifact.recorded';
  },

  apply(db: SqliteDatabase, event: DomainEvent, record: EventRecord): void {
    if (event.type !== 'artifact.recorded') return;
    const { executionId, ...fields } = event.payload;
    const row: ArtifactRecord = {
      ...fields,
      executionId: executionId ?? null,
      recordedAt: record.recordedAt,
    };
    // OR REPLACE: a rebuild replays events the table may already reflect.
    db.run(
      'INSERT OR REPLACE INTO artifacts (artifact_id, session_id, seq, record) VALUES (?, ?, ?, ?)',
      [row.artifactId, row.sessionId, record.seq, JSON.stringify(row)],
    );
  },
};

type ArtifactRow = { record: string };

const toRecord = (row: ArtifactRow): ArtifactRecord =>
  artifactRecordSchema.parse(JSON.parse(row.record));

/** A session's artifacts, newest first. */
export function listArtifacts(db: SqliteDatabase, sessionId: string): ArtifactRecord[] {
  return db
    .all<ArtifactRow>('SELECT record FROM artifacts WHERE session_id = ? ORDER BY seq DESC', [
      sessionId,
    ])
    .map(toRecord);
}

export function getArtifact(db: SqliteDatabase, artifactId: string): ArtifactRecord | undefined {
  const row = db.get<ArtifactRow>('SELECT record FROM artifacts WHERE artifact_id = ?', [
    artifactId,
  ]);
  return row ? toRecord(row) : undefined;
}

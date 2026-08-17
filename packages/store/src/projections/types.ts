import type { DomainEvent, DomainEventType } from '@sheep/core';
import type { EventRecord } from '../events/log';
import type { SqliteDatabase } from '../sqlite/types';

/**
 * A derived view of the event log.
 *
 * A projection owns its own tables, including their DDL. That is not a
 * shortcut around the migration runner — it is the distinction the migration
 * runner exists to protect. A migration guards data that exists nowhere else;
 * a projection holds nothing the log does not already contain, so its tables
 * can be dropped and rebuilt at any time, and a change to their shape is a
 * `ddlVersion` bump followed by a replay rather than a schema upgrade with a
 * backup and a checksum.
 */
export interface Projection {
  /** Stable key in `projection_state`. */
  readonly name: string;
  /** Bumped whenever `ddl` changes; a mismatch forces a rebuild. */
  readonly ddlVersion: number;
  /** Every table this projection owns, in drop order. */
  readonly tables: readonly string[];
  /** `CREATE TABLE`/`CREATE INDEX` statements for those tables. */
  readonly ddl: string;
  /** Whether this projection cares about an event type at all. */
  handles(type: DomainEventType): boolean;
  /** Folds one event into the tables. Called in strict `seq` order. */
  apply(db: SqliteDatabase, event: DomainEvent, record: EventRecord): void;
}

export interface ProjectionFailure {
  readonly seq: number;
  readonly type: string;
  readonly detail: string;
}

export interface ProjectionReport {
  readonly name: string;
  /** First sequence number this pass considered. */
  readonly fromSeq: number;
  /** Last sequence number seen, applied or not. */
  readonly lastSeq: number;
  readonly applied: number;
  /** Well-formed events this projection does not model. */
  readonly ignored: number;
  /** Events written by a build that knew types this one does not. */
  readonly unknown: number;
  /** True when the tables were emptied before replaying. */
  readonly rebuilt: boolean;
  /**
   * Events whose payload failed its schema. Reported rather than thrown: a
   * corrupt entry is a real problem, but refusing to open the app is a worse
   * response to it than showing what could still be rebuilt.
   */
  readonly failures: readonly ProjectionFailure[];
}

export interface ProjectionStatus {
  readonly name: string;
  readonly lastSeq: number;
  readonly ddlVersion: number;
  /** Events appended since this projection last caught up. */
  readonly behind: number;
  readonly ready: boolean;
}

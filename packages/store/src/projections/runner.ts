import { safeParseDomainEvent } from '@sheep/core';
import type { EventLog } from '../events/log';
import type { SqliteDatabase } from '../sqlite/types';
import { ARTIFACTS_PROJECTION } from './artifacts';
import { CORPUS_PROJECTION } from './corpus';
import { DERIVATIONS_PROJECTION } from './derivations';
import { EXECUTIONS_PROJECTION } from './executions';
import { RETRIEVALS_PROJECTION } from './retrievals';
import { SESSIONS_PROJECTION } from './sessions';
import type { Projection, ProjectionFailure, ProjectionReport, ProjectionStatus } from './types';

/** Every projection the app maintains. */
export const PROJECTIONS: readonly Projection[] = [
  SESSIONS_PROJECTION,
  EXECUTIONS_PROJECTION,
  DERIVATIONS_PROJECTION,
  ARTIFACTS_PROJECTION,
  RETRIEVALS_PROJECTION,
  CORPUS_PROJECTION,
];

export interface ProjectionRunnerOptions {
  readonly projections?: readonly Projection[];
  readonly now?: () => Date;
  /** How many failures to keep per pass before summarising. */
  readonly maxFailures?: number;
}

export interface EnsureResult {
  readonly name: string;
  /** The projection's tables were missing and had to be created. */
  readonly created: boolean;
  /** A shape change or a missing table forced a full replay. */
  readonly rebuilt: boolean;
  readonly report: ProjectionReport;
}

/**
 * Keeps derived tables in step with the event log.
 *
 * Two operations, and the difference between them matters. `catchUp` folds in
 * only the entries appended since last time, which is what makes it cheap
 * enough to run on every append. `rebuild` empties the tables first and replays
 * from the beginning, which is what makes the tables disposable — and disposable
 * is the point, because it is how the log stays the only thing that has to be
 * right (P5).
 *
 * Both run in a single transaction: the projected rows and the watermark that
 * says how far they go move together, or neither moves.
 */
export class ProjectionRunner {
  readonly #db: SqliteDatabase;
  readonly #log: EventLog;
  readonly #projections: readonly Projection[];
  readonly #now: () => Date;
  readonly #maxFailures: number;

  constructor(db: SqliteDatabase, log: EventLog, options: ProjectionRunnerOptions = {}) {
    this.#db = db;
    this.#log = log;
    this.#projections = options.projections ?? PROJECTIONS;
    this.#now = options.now ?? (() => new Date());
    this.#maxFailures = options.maxFailures ?? 50;
  }

  get projections(): readonly Projection[] {
    return this.#projections;
  }

  /**
   * Brings every projection into a usable state, creating tables that are
   * missing and rebuilding any whose shape has changed.
   *
   * Called on open, so a build that changes a projected column ships without a
   * migration: the old rows are thrown away and rebuilt from the log.
   */
  ensure(): EnsureResult[] {
    return this.#projections.map((projection) => {
      const state = this.#state(projection.name);
      const missing = this.#missingTables(projection);

      // No watermark means nothing is known about how far these rows go, and a
      // shape change means they were built to a different plan. Either way the
      // honest move is to throw them away rather than fold new events into rows
      // of uncertain provenance.
      const stale = state === undefined || state.ddl_version !== projection.ddlVersion;

      // Thrown away means dropped, not emptied: the DDL is `IF NOT EXISTS`, so a
      // table left standing keeps its old columns whatever the new plan says.
      if (stale) {
        for (const table of projection.tables) this.#db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      if (missing.length > 0 || stale) this.#db.exec(projection.ddl);
      const needsRebuild = missing.length > 0 || stale;

      const report = needsRebuild ? this.rebuild(projection) : this.catchUp(projection);
      return {
        name: projection.name,
        created: missing.length > 0,
        rebuilt: needsRebuild,
        report,
      };
    });
  }

  /** Folds in everything appended since the last pass. */
  catchUp(): ProjectionReport[];
  catchUp(only: Projection): ProjectionReport;
  catchUp(only?: Projection): ProjectionReport[] | ProjectionReport {
    if (only) return this.#run(only, false);
    return this.#projections.map((projection) => this.#run(projection, false));
  }

  /** Empties the tables and replays the whole log into them. */
  rebuild(): ProjectionReport[];
  rebuild(only: Projection): ProjectionReport;
  rebuild(only?: Projection): ProjectionReport[] | ProjectionReport {
    if (only) return this.#run(only, true);
    return this.#projections.map((projection) => this.#run(projection, true));
  }

  status(): ProjectionStatus[] {
    const head = this.#log.head()?.seq ?? 0;
    return this.#projections.map((projection) => {
      const state = this.#state(projection.name);
      const lastSeq = state?.last_seq ?? 0;
      return {
        name: projection.name,
        lastSeq,
        ddlVersion: state?.ddl_version ?? 0,
        behind: Math.max(0, head - lastSeq),
        ready: state !== undefined && this.#missingTables(projection).length === 0,
      };
    });
  }

  /** Drops a projection's tables and forgets its watermark. */
  drop(projection: Projection): void {
    this.#db.transaction(() => {
      for (const table of projection.tables) this.#db.exec(`DROP TABLE IF EXISTS ${table}`);
      this.#db.run('DELETE FROM projection_state WHERE name = ?', [projection.name]);
    });
  }

  #run(projection: Projection, rebuild: boolean): ProjectionReport {
    return this.#db.transaction(() => {
      if (this.#missingTables(projection).length > 0) this.#db.exec(projection.ddl);

      if (rebuild) {
        for (const table of projection.tables) this.#db.exec(`DELETE FROM ${table}`);
      }

      const fromSeq = rebuild ? 1 : (this.#state(projection.name)?.last_seq ?? 0) + 1;
      let lastSeq = fromSeq - 1;
      let applied = 0;
      let ignored = 0;
      let unknown = 0;
      const failures: ProjectionFailure[] = [];

      for (const record of this.#log.stream({ fromSeq })) {
        lastSeq = record.seq;

        const parsed = safeParseDomainEvent(record.type, record.payload);
        if (!parsed.ok) {
          // A type this build does not know is expected when opening a log a
          // newer version wrote; a payload that fails its own schema is not.
          if (parsed.error.name === 'UnknownEventTypeError') {
            unknown += 1;
          } else if (failures.length < this.#maxFailures) {
            failures.push({ seq: record.seq, type: record.type, detail: parsed.error.message });
          }
          continue;
        }

        if (!projection.handles(parsed.event.type)) {
          ignored += 1;
          continue;
        }

        projection.apply(this.#db, parsed.event, record);
        applied += 1;
      }

      this.#writeState(projection, lastSeq);

      return {
        name: projection.name,
        fromSeq,
        lastSeq,
        applied,
        ignored,
        unknown,
        rebuilt: rebuild,
        failures,
      };
    });
  }

  #state(name: string): { ddl_version: number; last_seq: number } | undefined {
    return this.#db.get<{ ddl_version: number; last_seq: number }>(
      'SELECT ddl_version, last_seq FROM projection_state WHERE name = ?',
      [name],
    );
  }

  #writeState(projection: Projection, lastSeq: number): void {
    this.#db.run(
      `INSERT INTO projection_state (name, ddl_version, last_seq, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         ddl_version = excluded.ddl_version,
         last_seq = excluded.last_seq,
         updated_at = excluded.updated_at`,
      [projection.name, projection.ddlVersion, lastSeq, this.#now().toISOString()],
    );
  }

  #missingTables(projection: Projection): string[] {
    return projection.tables.filter(
      (table) =>
        this.#db.get('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', [
          'table',
          table,
        ]) === undefined,
    );
  }
}

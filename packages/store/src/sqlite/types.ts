/**
 * The narrow SQLite surface Sheep depends on.
 *
 * Both the native driver and the WebAssembly fallback implement exactly this,
 * so nothing above the driver layer can accidentally depend on one of them.
 * Only positional (`?`) parameters are supported — named-parameter syntax
 * differs between the two drivers, and portability matters more than sugar.
 */
export type SqliteDriverName = 'better-sqlite3' | 'node-sqlite3-wasm';

export type SqlValue = string | number | bigint | null | Uint8Array;

export type SqlParams = readonly SqlValue[];

export type SqlRow = Record<string, SqlValue>;

export interface SqlRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface SqliteDatabase {
  readonly driver: SqliteDriverName;
  /** Runs one or more statements. No parameters, no results. */
  exec(sql: string): void;
  run(sql: string, params?: SqlParams): SqlRunResult;
  all<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): T[];
  get<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): T | undefined;
  /** Atomic unit of work; nests via savepoints. Rolls back on throw. */
  transaction<T>(work: () => T): T;
  close(): void;
  readonly isOpen: boolean;
}

export class SqliteDriverError extends Error {
  constructor(
    readonly driver: SqliteDriverName,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SqliteDriverError';
  }
}

/**
 * Shared transaction implementation, so both drivers behave identically:
 * outermost call uses BEGIN/COMMIT, nested calls use savepoints.
 */
export function createTransactionRunner(exec: (sql: string) => void): <T>(work: () => T) => T {
  let depth = 0;

  return function transaction<T>(work: () => T): T {
    const isOutermost = depth === 0;
    const savepoint = `sheep_sp_${String(depth)}`;
    exec(isOutermost ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
    depth += 1;
    try {
      const result = work();
      depth -= 1;
      exec(isOutermost ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      depth -= 1;
      try {
        exec(isOutermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
        if (!isOutermost) exec(`RELEASE ${savepoint}`);
      } catch {
        // The original failure is what matters; a rollback that itself fails
        // means the connection is already unusable.
      }
      throw error;
    }
  };
}

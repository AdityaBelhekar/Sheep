import { createRequire } from 'node:module';
import {
  createTransactionRunner,
  SqliteDriverError,
  type SqlParams,
  type SqlRow,
  type SqlRunResult,
  type SqliteDatabase,
} from './types';

const DRIVER = 'better-sqlite3' as const;

/** Minimal structural type for the parts of better-sqlite3 we use. */
interface BetterSqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface BetterSqliteDatabase {
  readonly open: boolean;
  exec(sql: string): unknown;
  prepare(sql: string): BetterSqliteStatement;
  close(): unknown;
}
type BetterSqliteConstructor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => BetterSqliteDatabase;

const require = createRequire(import.meta.url);

/**
 * Loaded through `createRequire` rather than a static import so a missing or
 * ABI-mismatched native build is a catchable runtime error instead of a crash
 * at module load — that is what makes the WebAssembly fallback possible.
 */
function loadConstructor(): BetterSqliteConstructor {
  try {
    return require('better-sqlite3') as BetterSqliteConstructor;
  } catch (error) {
    throw new SqliteDriverError(DRIVER, `native driver unavailable: ${describe(error)}`, {
      cause: error,
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.name) : String(error);
}

export function isBetterSqliteAvailable(): boolean {
  try {
    loadConstructor();
    return true;
  } catch {
    return false;
  }
}

export function openBetterSqlite(
  path: string,
  options: { readOnly?: boolean } = {},
): SqliteDatabase {
  const Constructor = loadConstructor();
  let handle: BetterSqliteDatabase;
  try {
    handle = new Constructor(path, options.readOnly === true ? { readonly: true } : {});
  } catch (error) {
    throw new SqliteDriverError(DRIVER, `could not open ${path}: ${describe(error)}`, {
      cause: error,
    });
  }

  const exec = (sql: string): void => {
    handle.exec(sql);
  };

  return {
    driver: DRIVER,
    get isOpen() {
      return handle.open;
    },
    exec,
    run(sql: string, params: SqlParams = []): SqlRunResult {
      return handle.prepare(sql).run(...params);
    },
    all<T extends SqlRow = SqlRow>(sql: string, params: SqlParams = []): T[] {
      return handle.prepare(sql).all(...params) as T[];
    },
    get<T extends SqlRow = SqlRow>(sql: string, params: SqlParams = []): T | undefined {
      return (handle.prepare(sql).get(...params) as T | undefined) ?? undefined;
    },
    transaction: createTransactionRunner(exec),
    close() {
      handle.close();
    },
  };
}

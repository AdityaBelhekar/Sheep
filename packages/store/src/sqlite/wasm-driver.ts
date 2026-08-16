import { createRequire } from 'node:module';
import {
  createTransactionRunner,
  SqliteDriverError,
  type SqlParams,
  type SqlRow,
  type SqlRunResult,
  type SqliteDatabase,
} from './types';

const DRIVER = 'node-sqlite3-wasm' as const;

interface WasmDatabase {
  readonly isOpen: boolean;
  exec(sql: string): void;
  run(
    sql: string,
    values?: readonly unknown[],
  ): { changes: number; lastInsertRowid: number | bigint };
  all(sql: string, values?: readonly unknown[]): unknown[];
  get(sql: string, values?: readonly unknown[]): unknown;
  close(): void;
}
type WasmConstructor = new (
  path: string,
  options?: { readOnly?: boolean; fileMustExist?: boolean },
) => WasmDatabase;

const require = createRequire(import.meta.url);

function describe(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.name) : String(error);
}

function loadConstructor(): WasmConstructor {
  try {
    const module = require('node-sqlite3-wasm') as { Database: WasmConstructor };
    return module.Database;
  } catch (error) {
    throw new SqliteDriverError(DRIVER, `wasm driver unavailable: ${describe(error)}`, {
      cause: error,
    });
  }
}

/**
 * Pure-WebAssembly fallback. Always available — no compiler, no ABI match
 * needed — which is why it is the safety net when the native build is unusable
 * (a different Node ABI, a machine with no build tools, a locked-down box).
 */
export function openWasmSqlite(path: string, options: { readOnly?: boolean } = {}): SqliteDatabase {
  const Constructor = loadConstructor();
  let handle: WasmDatabase;
  try {
    handle = new Constructor(path, options.readOnly === true ? { readOnly: true } : {});
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
      return handle.isOpen;
    },
    exec,
    run(sql: string, params: SqlParams = []): SqlRunResult {
      return handle.run(sql, params);
    },
    all<T extends SqlRow = SqlRow>(sql: string, params: SqlParams = []): T[] {
      return handle.all(sql, params) as T[];
    },
    get<T extends SqlRow = SqlRow>(sql: string, params: SqlParams = []): T | undefined {
      return (handle.get(sql, params) as T | null) ?? undefined;
    },
    transaction: createTransactionRunner(exec),
    close() {
      handle.close();
    },
  };
}

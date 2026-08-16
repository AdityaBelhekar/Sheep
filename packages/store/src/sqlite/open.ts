import { openBetterSqlite } from './better-sqlite3-driver';
import { SqliteDriverError, type SqliteDatabase, type SqliteDriverName } from './types';
import { openWasmSqlite } from './wasm-driver';

export type DriverPreference = SqliteDriverName | 'auto';

export interface OpenDatabaseOptions {
  /** File path, or `:memory:` for an ephemeral database. */
  readonly path: string;
  /** `auto` prefers the native driver and falls back to WebAssembly. */
  readonly driver?: DriverPreference;
  readonly readOnly?: boolean;
}

export interface OpenedDatabase {
  readonly db: SqliteDatabase;
  readonly driver: SqliteDriverName;
  /** The journal mode SQLite actually reports after we ask for WAL. */
  readonly journalMode: string;
  /** True only when WAL was granted; the WASM VFS cannot provide it. */
  readonly walEnabled: boolean;
  /** Set when the native driver was tried and rejected. */
  readonly fallbackReason?: string;
}

const DEFAULT_PRAGMAS = ['PRAGMA foreign_keys = ON', 'PRAGMA busy_timeout = 5000'] as const;

/**
 * Opens a database, preferring the native driver and falling back to the
 * WebAssembly build when the native one cannot load (wrong ABI, no prebuild,
 * no toolchain). WAL is requested; the mode actually granted is reported back
 * rather than assumed — `:memory:` databases, for instance, never get it.
 */
export function openDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  const preference = options.driver ?? 'auto';
  const openOptions = options.readOnly === true ? { readOnly: true } : {};

  let db: SqliteDatabase;
  let fallbackReason: string | undefined;

  if (preference === 'node-sqlite3-wasm') {
    db = openWasmSqlite(options.path, openOptions);
  } else if (preference === 'better-sqlite3') {
    db = openBetterSqlite(options.path, openOptions);
  } else {
    try {
      db = openBetterSqlite(options.path, openOptions);
    } catch (error) {
      fallbackReason =
        error instanceof SqliteDriverError
          ? error.message
          : `native driver unavailable: ${String(error)}`;
      db = openWasmSqlite(options.path, openOptions);
    }
  }

  if (options.readOnly !== true) {
    db.exec('PRAGMA journal_mode = WAL');
    for (const pragma of DEFAULT_PRAGMAS) db.exec(pragma);
  }

  const row = db.get<{ journal_mode: string }>('PRAGMA journal_mode');
  const journalMode = row?.journal_mode ?? 'unknown';
  const walEnabled = journalMode.toLowerCase() === 'wal';

  if (options.readOnly !== true) {
    // WAL plus synchronous=NORMAL is crash-safe. A rollback journal is not, so
    // when WAL is refused — the WebAssembly VFS has no shared memory, and
    // `:memory:` databases have no journal at all — pay for full syncs instead
    // of quietly running with weaker durability than we advertise.
    db.exec(walEnabled ? 'PRAGMA synchronous = NORMAL' : 'PRAGMA synchronous = FULL');
  }

  return fallbackReason === undefined
    ? { db, driver: db.driver, journalMode, walEnabled }
    : { db, driver: db.driver, journalMode, walEnabled, fallbackReason };
}

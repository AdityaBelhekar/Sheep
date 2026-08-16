import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Migration } from './migrations/definitions';
import { runMigrations, type MigrationReport } from './migrations/runner';
import { openDatabase, type DriverPreference } from './sqlite/open';
import type { SqliteDatabase, SqliteDriverName } from './sqlite/types';

export const DATABASE_FILENAME = 'sheep.sqlite';
export const BACKUP_DIRNAME = 'backups';
export const DEFAULT_BACKUP_RETENTION = 5;

export interface SheepStoreOptions {
  /** Directory Sheep owns; created if missing. Normally the user data path. */
  readonly dataDir: string;
  readonly driver?: DriverPreference;
  /** How many pre-migration backups to keep. */
  readonly backupRetention?: number;
  /** Override the migration set. Tests use this; the app never does. */
  readonly migrations?: readonly Migration[];
}

export interface SheepStore {
  readonly db: SqliteDatabase;
  readonly path: string;
  readonly dataDir: string;
  readonly driver: SqliteDriverName;
  readonly journalMode: string;
  /** Why the native driver was not used, when it was not. */
  readonly fallbackReason?: string;
  readonly migrations: MigrationReport;
  readonly schemaVersion: number;
  close(): void;
}

/**
 * Opens (creating if needed) the Sheep database and brings its schema up to
 * date. Safe to call on every launch: migrations already applied are skipped,
 * and an upgrade backs the file up first.
 */
export function openSheepStore(options: SheepStoreOptions): SheepStore {
  mkdirSync(options.dataDir, { recursive: true });
  const path = join(options.dataDir, DATABASE_FILENAME);
  const retention = options.backupRetention ?? DEFAULT_BACKUP_RETENTION;

  const opened = openDatabase({ path, driver: options.driver ?? 'auto' });

  let migrations: MigrationReport;
  try {
    migrations = runMigrations(opened.db, {
      ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
      backup: (fromVersion) =>
        backupDatabase(opened.db, path, options.dataDir, fromVersion, retention),
    });
  } catch (error) {
    opened.db.close();
    throw error;
  }

  const store: SheepStore = {
    db: opened.db,
    path,
    dataDir: options.dataDir,
    driver: opened.driver,
    journalMode: opened.journalMode,
    ...(opened.fallbackReason === undefined ? {} : { fallbackReason: opened.fallbackReason }),
    migrations,
    schemaVersion: migrations.finalVersion,
    close() {
      if (opened.db.isOpen) opened.db.close();
    },
  };
  return store;
}

/**
 * Snapshots the database before a schema change.
 *
 * `VACUUM INTO` is preferred because it is transactionally consistent and
 * folds in the WAL; if a driver refuses it, we checkpoint and copy the file so
 * an upgrade is never attempted without *some* recoverable copy.
 */
export function backupDatabase(
  db: SqliteDatabase,
  databasePath: string,
  dataDir: string,
  fromVersion: number,
  retention = DEFAULT_BACKUP_RETENTION,
): string {
  const directory = join(dataDir, BACKUP_DIRNAME);
  mkdirSync(directory, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(directory, `sheep-v${String(fromVersion)}-${stamp}.sqlite`);

  try {
    db.run('VACUUM INTO ?', [target]);
  } catch {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(databasePath, target);
  }

  pruneBackups(directory, retention);
  return target;
}

const BACKUP_PATTERN = /^sheep-v\d+-.+\.sqlite$/;

/** Keeps the newest `retention` backups; filenames sort chronologically. */
export function pruneBackups(directory: string, retention: number): string[] {
  if (retention < 0) return [];
  const backups = readdirSync(directory)
    .filter((name) => BACKUP_PATTERN.test(name))
    .sort()
    .reverse();

  const removed: string[] = [];
  for (const name of backups.slice(retention)) {
    rmSync(join(directory, name), { force: true });
    removed.push(name);
  }
  return removed;
}

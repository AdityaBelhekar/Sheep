import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BlobStore, OBJECTS_DIRNAME } from './cas/blob-store';
import { ConnectionRegistry } from './connections';
import { CredentialRegistry } from './credentials';
import { EventLog, type AppendEventInput, type EventRecord } from './events/log';
import { enforceLedger } from './ledger';
import type { Migration } from './migrations/definitions';
import { runMigrations, type MigrationReport } from './migrations/runner';
import { ProjectionRunner, type EnsureResult } from './projections/runner';
import { SettingsStore } from './settings';
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
  /** The authoritative record. Everything else here is derived from it. */
  readonly events: EventLog;
  /** Content-addressed blobs, indexed by the same database. */
  readonly blobs: BlobStore;
  /** Derived tables, brought up to date on open. */
  readonly projections: ProjectionRunner;
  readonly projectionState: readonly EnsureResult[];
  readonly settings: SettingsStore;
  /** Credential handles. Never the credentials themselves. */
  readonly credentials: CredentialRegistry;
  /** Configured ways of reaching models. Configuration, not session history. */
  readonly connections: ConnectionRegistry;
  readonly driver: SqliteDriverName;
  readonly journalMode: string;
  /** Why the native driver was not used, when it was not. */
  readonly fallbackReason?: string;
  readonly migrations: MigrationReport;
  readonly schemaVersion: number;
  /**
   * Appends events and folds them into the projections in one transaction, so
   * a reader can never see a log entry the derived tables do not reflect.
   *
   * Claim, dispute, execution and derivation events are checked against the
   * session's ledger first (P2), and a batch with one violation writes nothing.
   */
  record(inputs: readonly AppendEventInput[]): EventRecord[];
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

  const events = new EventLog(opened.db);
  const projections = new ProjectionRunner(opened.db, events);

  const settings = new SettingsStore(opened.db);

  let projectionState: EnsureResult[];
  try {
    projectionState = projections.ensure();
    settings.pruneUnknown();
  } catch (error) {
    opened.db.close();
    throw error;
  }

  const store: SheepStore = {
    db: opened.db,
    path,
    dataDir: options.dataDir,
    events,
    blobs: new BlobStore(opened.db, join(options.dataDir, OBJECTS_DIRNAME)),
    projections,
    projectionState,
    settings,
    credentials: new CredentialRegistry(opened.db),
    connections: new ConnectionRegistry(opened.db),
    driver: opened.driver,
    journalMode: opened.journalMode,
    ...(opened.fallbackReason === undefined ? {} : { fallbackReason: opened.fallbackReason }),
    migrations,
    schemaVersion: migrations.finalVersion,
    record(inputs) {
      return opened.db.transaction(() => {
        const prepared = inputs.map(withPayloadSessionId);
        enforceLedger(events, prepared);
        const written = events.appendAll(prepared);
        projections.catchUp();
        return written;
      });
    },
    close() {
      if (opened.db.isOpen) opened.db.close();
    },
  };
  return store;
}

/**
 * Mirrors a payload's own `sessionId` into the log's indexed column.
 *
 * Domain payloads are self-contained and name the session they belong to; the
 * `events.session_id` column exists so that reading one session's history does
 * not mean parsing every payload in the log. Deriving it here keeps the two from
 * ever disagreeing, which they would if each caller had to remember to pass it.
 */
function withPayloadSessionId(input: AppendEventInput): AppendEventInput {
  if (input.sessionId !== undefined) return input;

  const payload = input.payload;
  const sessionId =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? payload['sessionId']
      : undefined;

  return { ...input, sessionId: typeof sessionId === 'string' ? sessionId : null };
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

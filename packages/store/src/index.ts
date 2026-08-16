/**
 * @sheep/store — SQLite storage, migrations, event log and content-addressed
 * blobs.
 */
export const PACKAGE_NAME = '@sheep/store';

export {
  openDatabase,
  type DriverPreference,
  type OpenDatabaseOptions,
  type OpenedDatabase,
} from './sqlite/open';
export {
  SqliteDriverError,
  type SqlParams,
  type SqlRow,
  type SqlRunResult,
  type SqlValue,
  type SqliteDatabase,
  type SqliteDriverName,
} from './sqlite/types';
export { MIGRATIONS, type Migration } from './migrations/definitions';
export {
  assertValidMigrationList,
  checksumOf,
  currentSchemaVersion,
  MigrationChecksumError,
  MigrationDefinitionError,
  MigrationError,
  readAppliedMigrations,
  runMigrations,
  SchemaAheadError,
  type AppliedMigration,
  type MigrationReport,
  type RunMigrationsOptions,
} from './migrations/runner';
export {
  canonicalJson,
  CanonicalJsonError,
  parseJson,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
} from './events/json';
export { GENESIS_HASH, hashEntry, hashPayload, sha256Hex, type HashableEntry } from './events/hash';
export {
  EventLog,
  EventLogError,
  HEAD_ANCHOR_KEY,
  type AppendEventInput,
  type ChainFailure,
  type ChainFailureReason,
  type ChainHead,
  type ChainVerification,
  type EventLogOptions,
  type EventRecord,
  type ReadEventsOptions,
} from './events/log';
export {
  BACKUP_DIRNAME,
  DATABASE_FILENAME,
  DEFAULT_BACKUP_RETENTION,
  backupDatabase,
  openSheepStore,
  pruneBackups,
  type SheepStore,
  type SheepStoreOptions,
} from './store';

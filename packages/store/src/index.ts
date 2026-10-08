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
  BlobNotFoundError,
  BlobStore,
  BlobStoreError,
  DEFAULT_STALE_TEMP_MS,
  OBJECTS_DIRNAME,
  TEMP_DIRNAME,
  type BlobInfo,
  type BlobRef,
  type BlobStat,
  type BlobStoreOptions,
  type GcOptions,
  type GcReport,
} from './cas/blob-store';
export {
  CredentialRegistry,
  CredentialRegistryError,
  newCredentialRef,
  type RegisterCredentialInput,
} from './credentials';
export {
  ConnectionRegistry,
  ConnectionRegistryError,
  newAdapterId,
  type AddConnectionInput,
  type UpdateConnectionInput,
} from './connections';
export { SettingsStore } from './settings';
export { enforceLedger, readLedger } from './ledger';
export { executionBlobRef, recordExecution, type FinishedRun } from './executions';
export { derivationBlobRef, readDerivation, recordDerivation } from './derivations';
export {
  DERIVATIONS_DDL,
  DERIVATIONS_PROJECTION,
  getDerivation,
  listDerivations,
} from './projections/derivations';
export {
  EXECUTIONS_DDL,
  EXECUTIONS_PROJECTION,
  getExecution,
  listExecutions,
} from './projections/executions';
export {
  PROJECTIONS,
  ProjectionRunner,
  type EnsureResult,
  type ProjectionRunnerOptions,
} from './projections/runner';
export {
  SESSIONS_DDL,
  SESSIONS_PROJECTION,
  countSessions,
  getMessage,
  getParticipant,
  getSession,
  listMessages,
  listParticipants,
  listSessions,
  type RosterEntry,
  type SessionSummary,
} from './projections/sessions';
export type {
  Projection,
  ProjectionFailure,
  ProjectionReport,
  ProjectionStatus,
} from './projections/types';
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

import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '../sqlite/types';
import { MIGRATIONS, type Migration } from './definitions';

const BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT;
`;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** An already-applied migration's SQL has changed since it ran. */
export class MigrationChecksumError extends MigrationError {}

/** The database was written by a newer build than this one. */
export class SchemaAheadError extends MigrationError {}

/** The migration list itself is malformed (gaps, duplicates, bad order). */
export class MigrationDefinitionError extends MigrationError {}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationReport {
  readonly startingVersion: number;
  readonly finalVersion: number;
  readonly applied: readonly { version: number; name: string }[];
  /** Path of the pre-migration backup, when one was taken. */
  readonly backupPath?: string;
}

export interface RunMigrationsOptions {
  readonly migrations?: readonly Migration[];
  /**
   * Taken once, before the first pending migration, and only for a database
   * that already has schema in it. Returns the backup's path.
   */
  readonly backup?: (fromVersion: number) => string | undefined;
  readonly now?: () => Date;
}

/** Stable over formatting changes, sensitive to anything that alters meaning. */
export function checksumOf(migration: Migration): string {
  const normalised = migration.up.replace(/\s+/g, ' ').trim();
  return createHash('sha256')
    .update(`${String(migration.version)}:${migration.name}:${normalised}`)
    .digest('hex');
}

export function assertValidMigrationList(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new MigrationDefinitionError(
        `migration list must be contiguous and sorted from 1: expected version ${String(expected)}, found ${String(migration.version)} (${migration.name})`,
      );
    }
    if (migration.name.trim() === '') {
      throw new MigrationDefinitionError(
        `migration ${String(migration.version)} has an empty name`,
      );
    }
  });
}

export function readAppliedMigrations(db: SqliteDatabase): AppliedMigration[] {
  db.exec(BOOTSTRAP_SQL);
  return db
    .all<{ version: number; name: string; checksum: string; applied_at: string }>(
      'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
    )
    .map((row) => ({
      version: row.version,
      name: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at,
    }));
}

export function currentSchemaVersion(db: SqliteDatabase): number {
  const applied = readAppliedMigrations(db);
  return applied.at(-1)?.version ?? 0;
}

/**
 * Applies every pending migration, in order, each in its own transaction.
 *
 * Running it again on an up-to-date database is a no-op: this function is the
 * only thing that writes `schema_migrations`, and it applies strictly by
 * version. It refuses to touch a database whose history disagrees with the
 * build's — an edited migration or a newer schema both stop the app rather
 * than silently corrupting data.
 */
export function runMigrations(
  db: SqliteDatabase,
  options: RunMigrationsOptions = {},
): MigrationReport {
  const migrations = options.migrations ?? MIGRATIONS;
  const now = options.now ?? (() => new Date());
  assertValidMigrationList(migrations);

  const applied = readAppliedMigrations(db);
  const startingVersion = applied.at(-1)?.version ?? 0;

  if (startingVersion > migrations.length) {
    throw new SchemaAheadError(
      `database schema is at version ${String(startingVersion)} but this build only knows ${String(migrations.length)} migrations`,
    );
  }

  for (const row of applied) {
    const definition = migrations[row.version - 1];
    if (!definition) {
      throw new SchemaAheadError(
        `applied migration ${String(row.version)} is unknown to this build`,
      );
    }
    const checksum = checksumOf(definition);
    if (checksum !== row.checksum) {
      throw new MigrationChecksumError(
        `migration ${String(row.version)} (${definition.name}) has changed since it was applied; recorded ${row.checksum.slice(0, 12)}…, computed ${checksum.slice(0, 12)}…`,
      );
    }
  }

  const pending = migrations.filter((migration) => migration.version > startingVersion);
  if (pending.length === 0) {
    return { startingVersion, finalVersion: startingVersion, applied: [] };
  }

  const backupPath = startingVersion > 0 ? options.backup?.(startingVersion) : undefined;

  const appliedNow: { version: number; name: string }[] = [];
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.up);
      db.run(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        [migration.version, migration.name, checksumOf(migration), now().toISOString()],
      );
    });
    setUserVersion(db, migration.version);
    appliedNow.push({ version: migration.version, name: migration.name });
  }

  const finalVersion = pending.at(-1)?.version ?? startingVersion;
  return backupPath === undefined
    ? { startingVersion, finalVersion, applied: appliedNow }
    : { startingVersion, finalVersion, applied: appliedNow, backupPath };
}

/** `PRAGMA user_version` cannot be parameterised, so the value is validated. */
function setUserVersion(db: SqliteDatabase, version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new MigrationDefinitionError(`invalid schema version: ${String(version)}`);
  }
  db.exec(`PRAGMA user_version = ${String(version)}`);
}

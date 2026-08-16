import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../sqlite/open';
import type { SqliteDatabase } from '../sqlite/types';
import { TESTABLE_DRIVERS } from '../test-support';
import { MIGRATIONS, type Migration } from './definitions';
import {
  assertValidMigrationList,
  checksumOf,
  currentSchemaVersion,
  MigrationChecksumError,
  MigrationDefinitionError,
  readAppliedMigrations,
  runMigrations,
  SchemaAheadError,
} from './runner';

const FIXTURE: readonly Migration[] = [
  { version: 1, name: 'first', up: 'CREATE TABLE one (id INTEGER PRIMARY KEY) STRICT;' },
  { version: 2, name: 'second', up: 'CREATE TABLE two (id INTEGER PRIMARY KEY) STRICT;' },
];

function memoryDb(): SqliteDatabase {
  return openDatabase({ path: ':memory:' }).db;
}

function tableNames(db: SqliteDatabase): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => row.name);
}

describe('migration definitions', () => {
  it('ships a contiguous, sorted, named list', () => {
    expect(() => {
      assertValidMigrationList(MIGRATIONS);
    }).not.toThrow();
    expect(MIGRATIONS.length).toBeGreaterThan(0);
  });

  it('rejects a list with a gap', () => {
    expect(() => {
      assertValidMigrationList([
        { version: 1, name: 'a', up: 'SELECT 1;' },
        { version: 3, name: 'c', up: 'SELECT 1;' },
      ]);
    }).toThrow(MigrationDefinitionError);
  });

  it('rejects a list that does not start at 1', () => {
    expect(() => {
      assertValidMigrationList([{ version: 2, name: 'a', up: 'SELECT 1;' }]);
    }).toThrow(MigrationDefinitionError);
  });

  it('checksums ignore reformatting but not meaning', () => {
    const base: Migration = { version: 1, name: 'a', up: 'CREATE TABLE x (id INTEGER);' };
    const reformatted: Migration = {
      version: 1,
      name: 'a',
      up: '\n  CREATE TABLE x   (id INTEGER);\n',
    };
    const changed: Migration = { version: 1, name: 'a', up: 'CREATE TABLE y (id INTEGER);' };

    expect(checksumOf(reformatted)).toBe(checksumOf(base));
    expect(checksumOf(changed)).not.toBe(checksumOf(base));
  });
});

describe.each(TESTABLE_DRIVERS)('runMigrations on %s', (driver) => {
  function db(): SqliteDatabase {
    return openDatabase({ path: ':memory:', driver }).db;
  }

  it('applies the real migration set and creates its tables', () => {
    const database = db();
    try {
      const report = runMigrations(database);

      expect(report.startingVersion).toBe(0);
      expect(report.finalVersion).toBe(MIGRATIONS.length);
      expect(report.applied).toHaveLength(MIGRATIONS.length);
      expect(tableNames(database)).toContain('app_meta');
      expect(tableNames(database)).toContain('schema_migrations');
    } finally {
      database.close();
    }
  });

  it('is idempotent: a second run applies nothing and changes nothing', () => {
    const database = db();
    try {
      runMigrations(database);
      const before = readAppliedMigrations(database);

      const second = runMigrations(database);

      expect(second.applied).toEqual([]);
      expect(second.startingVersion).toBe(MIGRATIONS.length);
      expect(second.finalVersion).toBe(MIGRATIONS.length);
      expect(readAppliedMigrations(database)).toEqual(before);
    } finally {
      database.close();
    }
  });

  it('applies only what is pending when the list grows', () => {
    const database = db();
    try {
      runMigrations(database, { migrations: FIXTURE.slice(0, 1) });
      expect(currentSchemaVersion(database)).toBe(1);

      const report = runMigrations(database, { migrations: FIXTURE });

      expect(report.startingVersion).toBe(1);
      expect(report.applied).toEqual([{ version: 2, name: 'second' }]);
      expect(tableNames(database)).toEqual(expect.arrayContaining(['one', 'two']));
    } finally {
      database.close();
    }
  });

  it('records version, name, checksum and timestamp for each migration', () => {
    const database = db();
    try {
      runMigrations(database, {
        migrations: FIXTURE,
        now: () => new Date('2026-08-16T10:00:00.000Z'),
      });

      expect(readAppliedMigrations(database)).toEqual([
        {
          version: 1,
          name: 'first',
          checksum: checksumOf(FIXTURE[0]!),
          appliedAt: '2026-08-16T10:00:00.000Z',
        },
        {
          version: 2,
          name: 'second',
          checksum: checksumOf(FIXTURE[1]!),
          appliedAt: '2026-08-16T10:00:00.000Z',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('keeps PRAGMA user_version in step with the schema', () => {
    const database = db();
    try {
      runMigrations(database, { migrations: FIXTURE });
      expect(database.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(2);
    } finally {
      database.close();
    }
  });

  it('refuses to run when an applied migration has been edited', () => {
    const database = db();
    try {
      runMigrations(database, { migrations: FIXTURE });

      const edited: Migration[] = [
        { version: 1, name: 'first', up: 'CREATE TABLE one_renamed (id INTEGER PRIMARY KEY);' },
        FIXTURE[1]!,
      ];

      expect(() => runMigrations(database, { migrations: edited })).toThrow(MigrationChecksumError);
    } finally {
      database.close();
    }
  });

  it('refuses a database written by a newer build', () => {
    const database = db();
    try {
      runMigrations(database, { migrations: FIXTURE });

      expect(() => runMigrations(database, { migrations: FIXTURE.slice(0, 1) })).toThrow(
        SchemaAheadError,
      );
    } finally {
      database.close();
    }
  });

  it('rolls a failing migration back rather than half-applying it', () => {
    const database = db();
    try {
      const broken: Migration[] = [
        {
          version: 1,
          name: 'broken',
          up: 'CREATE TABLE good (id INTEGER PRIMARY KEY) STRICT; CREATE TABLE bad (;',
        },
      ];

      expect(() => runMigrations(database, { migrations: broken })).toThrow();
      expect(tableNames(database)).not.toContain('good');
      expect(currentSchemaVersion(database)).toBe(0);
    } finally {
      database.close();
    }
  });

  it('takes a backup before upgrading an existing database, but not on first create', () => {
    const database = db();
    try {
      const backup = vi.fn(() => '/tmp/backup.sqlite');

      const first = runMigrations(database, { migrations: FIXTURE.slice(0, 1), backup });
      expect(backup).not.toHaveBeenCalled();
      expect(first.backupPath).toBeUndefined();

      const second = runMigrations(database, { migrations: FIXTURE, backup });
      expect(backup).toHaveBeenCalledWith(1);
      expect(second.backupPath).toBe('/tmp/backup.sqlite');
    } finally {
      database.close();
    }
  });
});

describe('runMigrations bootstrapping', () => {
  it('creates its own bookkeeping table on an empty database', () => {
    const database = memoryDb();
    try {
      expect(tableNames(database)).not.toContain('schema_migrations');
      expect(readAppliedMigrations(database)).toEqual([]);
      expect(tableNames(database)).toContain('schema_migrations');
    } finally {
      database.close();
    }
  });
});

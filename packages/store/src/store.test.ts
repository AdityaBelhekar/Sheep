import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, type Migration } from './migrations/definitions';
import { openDatabase } from './sqlite/open';
import { BACKUP_DIRNAME, DATABASE_FILENAME, openSheepStore, pruneBackups } from './store';
import { TESTABLE_DRIVERS, useTempDir } from './test-support';

const tempDir = useTempDir('sheep-store-');

let counter = 0;
function dataDir(): string {
  counter += 1;
  return join(tempDir(), `run-${String(counter)}`);
}

/** The shipped list plus one extra migration, i.e. "a newer build". */
const NEXT_BUILD: readonly Migration[] = [
  ...MIGRATIONS,
  {
    version: MIGRATIONS.length + 1,
    name: 'probe',
    up: 'CREATE TABLE probe (id INTEGER PRIMARY KEY) STRICT;',
  },
];

describe.each(TESTABLE_DRIVERS)('openSheepStore on %s', (driver) => {
  it('creates the data directory and database file, and applies migrations', () => {
    const dir = dataDir();
    const store = openSheepStore({ dataDir: dir, driver });
    try {
      expect(store.path).toBe(join(dir, DATABASE_FILENAME));
      expect(existsSync(store.path)).toBe(true);
      expect(store.schemaVersion).toBe(MIGRATIONS.length);
      expect(store.migrations.applied).toHaveLength(MIGRATIONS.length);
      expect(store.driver).toBe(driver);
      expect(store.journalMode.toLowerCase()).toBe(driver === 'better-sqlite3' ? 'wal' : 'delete');
      expect(
        store.db.get('SELECT value FROM app_meta WHERE key = ?', ['schema_initialised_at']),
      ).toBeDefined();
    } finally {
      store.close();
    }
  });

  it('reopening applies nothing and preserves data', () => {
    const dir = dataDir();

    const first = openSheepStore({ dataDir: dir, driver });
    first.db.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', ['probe', 'kept']);
    first.close();

    const second = openSheepStore({ dataDir: dir, driver });
    try {
      expect(second.migrations.applied).toEqual([]);
      expect(second.migrations.backupPath).toBeUndefined();
      expect(second.schemaVersion).toBe(MIGRATIONS.length);
      expect(
        second.db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', ['probe'])
          ?.value,
      ).toBe('kept');
    } finally {
      second.close();
    }
  });

  it('closing twice is safe', () => {
    const store = openSheepStore({ dataDir: dataDir(), driver });
    store.close();
    expect(() => {
      store.close();
    }).not.toThrow();
  });

  it('takes an openable backup before an upgrade, and none on first create', () => {
    const dir = dataDir();

    const initial = openSheepStore({ dataDir: dir, driver });
    initial.db.run('INSERT INTO app_meta (key, value) VALUES (?, ?)', ['before', 'upgrade']);
    expect(initial.migrations.backupPath).toBeUndefined();
    expect(existsSync(join(dir, BACKUP_DIRNAME))).toBe(false);
    initial.close();

    const upgraded = openSheepStore({ dataDir: dir, driver, migrations: NEXT_BUILD });
    const backupPath = upgraded.migrations.backupPath;
    try {
      expect(upgraded.migrations.applied).toEqual([{ version: NEXT_BUILD.length, name: 'probe' }]);
      expect(backupPath).toBeDefined();
      expect(existsSync(backupPath!)).toBe(true);
      expect(upgraded.db.all("SELECT name FROM sqlite_master WHERE name = 'probe'")).toHaveLength(
        1,
      );
    } finally {
      upgraded.close();
    }

    // The backup is a usable database holding the pre-upgrade state.
    const restored = openDatabase({ path: backupPath!, driver });
    try {
      expect(
        restored.db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', ['before'])
          ?.value,
      ).toBe('upgrade');
      expect(restored.db.all("SELECT name FROM sqlite_master WHERE name = 'probe'")).toHaveLength(
        0,
      );
    } finally {
      restored.db.close();
    }
  });
});

describe('backup retention', () => {
  it('keeps only the newest backups and ignores unrelated files', () => {
    const dir = dataDir();
    const backupDir = join(dir, BACKUP_DIRNAME);
    mkdirSync(backupDir, { recursive: true });

    for (const stamp of ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']) {
      writeFileSync(join(backupDir, `sheep-v1-${stamp}.sqlite`), 'x');
    }
    writeFileSync(join(backupDir, 'unrelated.txt'), 'x');

    const removed = pruneBackups(backupDir, 2);

    expect(removed).toEqual(['sheep-v1-2026-02-01.sqlite', 'sheep-v1-2026-01-01.sqlite']);
    expect(readdirSync(backupDir).sort()).toEqual([
      'sheep-v1-2026-03-01.sqlite',
      'sheep-v1-2026-04-01.sqlite',
      'unrelated.txt',
    ]);
  });
});

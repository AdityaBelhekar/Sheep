import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TESTABLE_DRIVERS, useTempDir } from '../test-support';
import { openDatabase } from './open';
import { SqliteDriverError } from './types';

const tempDir = useTempDir('sheep-open-');

describe.each(TESTABLE_DRIVERS)('driver %s', (driver) => {
  it('creates the database file on disk', () => {
    const path = join(tempDir(), `${driver}.sqlite`);
    const { db } = openDatabase({ path, driver });
    try {
      expect(existsSync(path)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('reports the journal mode it was actually granted', () => {
    const { db, journalMode, walEnabled } = openDatabase({
      path: join(tempDir(), `${driver}-wal.sqlite`),
      driver,
    });
    try {
      // The native driver gets WAL. The WebAssembly VFS has no shared-memory
      // support, so SQLite refuses the switch and stays on a rollback journal;
      // that is reported rather than assumed.
      if (driver === 'better-sqlite3') {
        expect(journalMode.toLowerCase()).toBe('wal');
        expect(walEnabled).toBe(true);
      } else {
        expect(journalMode.toLowerCase()).toBe('delete');
        expect(walEnabled).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it('falls back to full synchronous durability when WAL is unavailable', () => {
    const { db, walEnabled } = openDatabase({
      path: join(tempDir(), `${driver}-sync.sqlite`),
      driver,
    });
    try {
      const synchronous = db.get<{ synchronous: number }>('PRAGMA synchronous')?.synchronous;
      expect(synchronous).toBe(walEnabled ? 1 : 2);
    } finally {
      db.close();
    }
  });

  it('round-trips values through positional parameters', () => {
    const { db } = openDatabase({ path: ':memory:', driver });
    try {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL, blob BLOB) STRICT');
      const result = db.run('INSERT INTO t (id, label, blob) VALUES (?, ?, ?)', [
        1,
        'hello',
        new Uint8Array([1, 2, 3]),
      ]);

      expect(result.changes).toBe(1);
      expect(db.get<{ label: string }>('SELECT label FROM t WHERE id = ?', [1])?.label).toBe(
        'hello',
      );
      expect(db.all('SELECT * FROM t')).toHaveLength(1);
      expect(db.get('SELECT * FROM t WHERE id = ?', [99])).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('commits a transaction and rolls back a failed one', () => {
    const { db } = openDatabase({ path: ':memory:', driver });
    try {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT');

      db.transaction(() => {
        db.run('INSERT INTO t (id) VALUES (?)', [1]);
      });
      expect(db.all('SELECT id FROM t')).toHaveLength(1);

      expect(() =>
        db.transaction(() => {
          db.run('INSERT INTO t (id) VALUES (?)', [2]);
          throw new Error('abort');
        }),
      ).toThrow('abort');
      expect(db.all('SELECT id FROM t')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('rolls back only the inner savepoint when a nested transaction fails', () => {
    const { db } = openDatabase({ path: ':memory:', driver });
    try {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT');

      db.transaction(() => {
        db.run('INSERT INTO t (id) VALUES (?)', [1]);
        try {
          db.transaction(() => {
            db.run('INSERT INTO t (id) VALUES (?)', [2]);
            throw new Error('inner');
          });
        } catch {
          // swallowed on purpose: the outer transaction should still commit
        }
      });

      expect(db.all<{ id: number }>('SELECT id FROM t ORDER BY id').map((row) => row.id)).toEqual([
        1,
      ]);
    } finally {
      db.close();
    }
  });

  it('reports whether the connection is open', () => {
    const { db } = openDatabase({ path: ':memory:', driver });
    expect(db.isOpen).toBe(true);
    db.close();
    expect(db.isOpen).toBe(false);
  });
});

describe('driver selection', () => {
  it('reports the driver it actually opened', () => {
    const { db, driver } = openDatabase({ path: ':memory:' });
    try {
      expect(TESTABLE_DRIVERS).toContain(driver);
      expect(db.driver).toBe(driver);
    } finally {
      db.close();
    }
  });

  it('prefers the native driver when it is available', () => {
    if (!TESTABLE_DRIVERS.includes('better-sqlite3')) return;
    const { db, driver, fallbackReason } = openDatabase({ path: ':memory:', driver: 'auto' });
    try {
      expect(driver).toBe('better-sqlite3');
      expect(fallbackReason).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('surfaces a driver error rather than a crash when a path cannot be opened', () => {
    expect(() =>
      openDatabase({
        path: join(tempDir(), 'no', 'such', 'dir', 'x.sqlite'),
        driver: 'node-sqlite3-wasm',
      }),
    ).toThrow(SqliteDriverError);
  });
});

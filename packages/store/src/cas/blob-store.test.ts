import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations/definitions';
import { runMigrations } from '../migrations/runner';
import { openDatabase } from '../sqlite/open';
import type { SqliteDatabase, SqliteDriverName } from '../sqlite/types';
import { TESTABLE_DRIVERS, useTempDir } from '../test-support';
import {
  BlobNotFoundError,
  BlobStore,
  BlobStoreError,
  OBJECTS_DIRNAME,
  TEMP_DIRNAME,
} from './blob-store';

const tempDir = useTempDir('sheep-cas-');

let counter = 0;

interface Harness {
  readonly store: BlobStore;
  readonly db: SqliteDatabase;
  readonly root: string;
  /** Advances the clock the store sees. */
  setNow(date: Date): void;
  close(): void;
}

function harness(driver: SqliteDriverName): Harness {
  counter += 1;
  const dir = join(tempDir(), `run-${String(counter)}`);
  mkdirSync(dir, { recursive: true });

  const opened = openDatabase({ path: join(dir, 'sheep.sqlite'), driver });
  runMigrations(opened.db, { migrations: MIGRATIONS });

  let now = new Date('2026-08-17T09:00:00.000Z');
  const root = join(dir, OBJECTS_DIRNAME);

  return {
    db: opened.db,
    root,
    store: new BlobStore(opened.db, root, { now: () => now }),
    setNow(date) {
      now = date;
    },
    close() {
      opened.db.close();
    },
  };
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const MESSAGE = { kind: 'message', id: 'm-1' } as const;
const CLAIM = { kind: 'claim', id: 'c-1' } as const;

describe.each(TESTABLE_DRIVERS)('BlobStore on %s', (driver) => {
  it('addresses content by its sha-256 and shards on the first two hex digits', () => {
    const h = harness(driver);
    try {
      const info = h.store.put('hello sheep');
      const expected = sha('hello sheep');

      expect(info.hash).toBe(expected);
      expect(info.bytes).toBe(11);
      expect(info.deduplicated).toBe(false);
      expect(h.store.pathFor(expected)).toBe(join(h.root, expected.slice(0, 2), expected));
      expect(existsSync(h.store.pathFor(expected))).toBe(true);
      expect(h.store.readText(expected)).toBe('hello sheep');
      expect(h.store.has(expected)).toBe(true);
    } finally {
      h.close();
    }
  });

  it('stores identical content exactly once, however it arrives', async () => {
    const h = harness(driver);
    try {
      const first = h.store.put('duplicate me');
      const second = h.store.put(Buffer.from('duplicate me', 'utf8'));
      const third = await h.store.putStream(Readable.from(['duplicate', ' me']));

      expect(second.hash).toBe(first.hash);
      expect(third.hash).toBe(first.hash);
      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(third.deduplicated).toBe(true);

      expect(h.store.count()).toBe(1);
      expect(h.store.totalBytes()).toBe(12);
      expect(readdirSync(join(h.root, first.hash.slice(0, 2)))).toEqual([first.hash]);
      // The winning write left nothing behind for the losing ones to trip over.
      expect(readdirSync(join(h.root, TEMP_DIRNAME))).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('distinguishes content that differs by a single byte', () => {
    const h = harness(driver);
    try {
      const a = h.store.put('sheep');
      const b = h.store.put('sheeq');
      expect(a.hash).not.toBe(b.hash);
      expect(h.store.count()).toBe(2);
    } finally {
      h.close();
    }
  });

  it('streams a large payload without holding it in memory, and hashes it correctly', async () => {
    const h = harness(driver);
    try {
      // 4 MiB in 1 KiB chunks: more than any single buffer the store allocates.
      const chunk = 'x'.repeat(1024);
      const chunks = 4 * 1024;
      const info = await h.store.putStream(
        Readable.from(
          (function* () {
            for (let i = 0; i < chunks; i += 1) yield Buffer.from(chunk, 'utf8');
          })(),
        ),
      );

      expect(info.bytes).toBe(chunks * 1024);
      expect(info.hash).toBe(sha(chunk.repeat(chunks)));
      expect(statSync(h.store.pathFor(info.hash)).size).toBe(chunks * 1024);
      expect(h.store.verify(info.hash)).toBe(true);
    } finally {
      h.close();
    }
  });

  it('ingests a file from disk', async () => {
    const h = harness(driver);
    try {
      const source = join(tempDir(), 'artifact.csv');
      writeFileSync(source, 'a,b\n1,2\n');
      const info = await h.store.putFile(source, CLAIM);

      expect(info.hash).toBe(sha('a,b\n1,2\n'));
      expect(h.store.readText(info.hash)).toBe('a,b\n1,2\n');
      expect(h.store.refs(info.hash)).toEqual([{ kind: 'claim', id: 'c-1' }]);
    } finally {
      h.close();
    }
  });

  it('leaves nothing behind when a stream fails mid-write', async () => {
    const h = harness(driver);
    try {
      const failing = Readable.from(
        (function* () {
          yield Buffer.from('partial');
          throw new Error('source exploded');
        })(),
      );

      await expect(h.store.putStream(failing)).rejects.toThrow(BlobStoreError);
      expect(h.store.count()).toBe(0);
      expect(readdirSync(join(h.root, TEMP_DIRNAME))).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('reports a readable size and creation time', () => {
    const h = harness(driver);
    try {
      const info = h.store.put('metadata');
      expect(h.store.stat(info.hash)).toEqual({
        hash: info.hash,
        bytes: 8,
        createdAt: '2026-08-17T09:00:00.000Z',
        refCount: 0,
      });
      expect(h.store.stat(sha('absent'))).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it('keeps the original creation time when the same content is stored again', () => {
    const h = harness(driver);
    try {
      const info = h.store.put('stable');
      h.setNow(new Date('2027-01-01T00:00:00.000Z'));
      h.store.put('stable');
      expect(h.store.stat(info.hash)?.createdAt).toBe('2026-08-17T09:00:00.000Z');
    } finally {
      h.close();
    }
  });

  it('refuses anything that is not a content address', () => {
    const h = harness(driver);
    try {
      for (const bad of ['', 'abc', 'g'.repeat(64), 'a'.repeat(63)]) {
        expect(() => h.store.read(bad)).toThrow(BlobStoreError);
        expect(() => h.store.pathFor(bad)).toThrow(BlobStoreError);
      }
      // Upper case is accepted as input but normalised, never stored twice.
      const info = h.store.put('case');
      expect(h.store.has(info.hash.toUpperCase())).toBe(true);
      expect(h.store.readText(info.hash.toUpperCase())).toBe('case');
    } finally {
      h.close();
    }
  });

  it('throws a specific error for a blob it does not have', () => {
    const h = harness(driver);
    try {
      const missing = sha('never stored');
      expect(() => h.store.read(missing)).toThrow(BlobNotFoundError);
      expect(() => h.store.openRead(missing)).toThrow(BlobNotFoundError);
      expect(h.store.has(missing)).toBe(false);
      expect(h.store.verify(missing)).toBe(false);
    } finally {
      h.close();
    }
  });

  it('detects a blob whose bytes have been corrupted on disk', () => {
    const h = harness(driver);
    try {
      const info = h.store.put('trustworthy');
      expect(h.store.verify(info.hash)).toBe(true);

      writeFileSync(h.store.pathFor(info.hash), 'tampered');
      expect(h.store.verify(info.hash)).toBe(false);
    } finally {
      h.close();
    }
  });

  it('streams a blob back out', async () => {
    const h = harness(driver);
    try {
      const info = h.store.put('streamed back');
      const chunks: Buffer[] = [];
      for await (const chunk of h.store.openRead(info.hash)) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks).toString('utf8')).toBe('streamed back');
    } finally {
      h.close();
    }
  });
});

describe.each(TESTABLE_DRIVERS)('reference counting on %s', (driver) => {
  it('counts distinct holders and is idempotent per holder', () => {
    const h = harness(driver);
    try {
      const { hash } = h.store.put('shared');

      h.store.retain(hash, MESSAGE);
      h.store.retain(hash, MESSAGE);
      expect(h.store.refCount(hash)).toBe(1);

      h.store.retain(hash, CLAIM);
      expect(h.store.refCount(hash)).toBe(2);
      expect(h.store.refs(hash)).toEqual([
        { kind: 'claim', id: 'c-1' },
        { kind: 'message', id: 'm-1' },
      ]);
    } finally {
      h.close();
    }
  });

  it('releases one holder at a time and reports whether it held anything', () => {
    const h = harness(driver);
    try {
      const { hash } = h.store.put('shared');
      h.store.retain(hash, MESSAGE);
      h.store.retain(hash, CLAIM);

      expect(h.store.release(hash, MESSAGE)).toBe(true);
      expect(h.store.release(hash, MESSAGE)).toBe(false);
      expect(h.store.refCount(hash)).toBe(1);
    } finally {
      h.close();
    }
  });

  it('answers both directions: who holds a blob, and what a holder holds', () => {
    const h = harness(driver);
    try {
      const a = h.store.put('first', MESSAGE);
      const b = h.store.put('second', MESSAGE);
      h.store.retain(a.hash, CLAIM);

      expect(h.store.heldBy(MESSAGE)).toEqual([a.hash, b.hash].sort());
      expect(h.store.heldBy(CLAIM)).toEqual([a.hash]);
      expect(h.store.releaseAll(MESSAGE)).toBe(2);
      expect(h.store.heldBy(MESSAGE)).toEqual([]);
      expect(h.store.refCount(a.hash)).toBe(1);
    } finally {
      h.close();
    }
  });

  it('refuses to retain a blob it does not have, or a reference with no owner', () => {
    const h = harness(driver);
    try {
      expect(() => {
        h.store.retain(sha('absent'), MESSAGE);
      }).toThrow(BlobNotFoundError);

      const { hash } = h.store.put('present');
      expect(() => {
        h.store.retain(hash, { kind: '', id: 'x' });
      }).toThrow(BlobStoreError);
      expect(() => {
        h.store.retain(hash, { kind: 'message', id: '  ' });
      }).toThrow(BlobStoreError);
    } finally {
      h.close();
    }
  });

  it('takes a first reference at write time', () => {
    const h = harness(driver);
    try {
      const info = h.store.put('retained on arrival', MESSAGE);
      expect(h.store.refCount(info.hash)).toBe(1);

      // Storing the same content for a second owner adds a reference, not a blob.
      const again = h.store.put('retained on arrival', CLAIM);
      expect(again.deduplicated).toBe(true);
      expect(h.store.count()).toBe(1);
      expect(h.store.refCount(info.hash)).toBe(2);
    } finally {
      h.close();
    }
  });
});

describe.each(TESTABLE_DRIVERS)('garbage collection on %s', (driver) => {
  it('removes unreferenced blobs and only those', () => {
    const h = harness(driver);
    try {
      const held = h.store.put('keep me', MESSAGE);
      const orphaned = h.store.put('collect me');
      const released = h.store.put('once held', CLAIM);
      h.store.release(released.hash, CLAIM);

      expect(
        h.store
          .unreferenced()
          .map((blob) => blob.hash)
          .sort(),
      ).toEqual([orphaned.hash, released.hash].sort());

      const report = h.store.gc();

      expect([...report.removed].sort()).toEqual([orphaned.hash, released.hash].sort());
      expect(report.removedBytes).toBe(19);
      expect(report.keptCount).toBe(1);
      expect(report.orphans).toEqual([]);
      expect(report.missing).toEqual([]);

      expect(h.store.has(held.hash)).toBe(true);
      expect(h.store.readText(held.hash)).toBe('keep me');
      expect(h.store.has(orphaned.hash)).toBe(false);
      expect(existsSync(h.store.pathFor(orphaned.hash))).toBe(false);
      expect(existsSync(h.store.pathFor(released.hash))).toBe(false);
    } finally {
      h.close();
    }
  });

  it('is a no-op when everything is referenced', () => {
    const h = harness(driver);
    try {
      const a = h.store.put('a', MESSAGE);
      const b = h.store.put('b', CLAIM);

      const report = h.store.gc();
      expect(report.removed).toEqual([]);
      expect(report.removedBytes).toBe(0);
      expect(report.keptCount).toBe(2);
      expect(h.store.has(a.hash)).toBe(true);
      expect(h.store.has(b.hash)).toBe(true);
    } finally {
      h.close();
    }
  });

  it('changes nothing under dryRun', () => {
    const h = harness(driver);
    try {
      const doomed = h.store.put('unreferenced');

      const report = h.store.gc({ dryRun: true });
      expect(report.removed).toEqual([doomed.hash]);
      expect(h.store.has(doomed.hash)).toBe(true);
      expect(existsSync(h.store.pathFor(doomed.hash))).toBe(true);

      h.store.gc();
      expect(h.store.has(doomed.hash)).toBe(false);
    } finally {
      h.close();
    }
  });

  it('keeps a blob alive while any one holder remains', () => {
    const h = harness(driver);
    try {
      const { hash } = h.store.put('shared', MESSAGE);
      h.store.retain(hash, CLAIM);

      h.store.release(hash, MESSAGE);
      expect(h.store.gc().removed).toEqual([]);
      expect(h.store.has(hash)).toBe(true);

      h.store.release(hash, CLAIM);
      expect(h.store.gc().removed).toEqual([hash]);
    } finally {
      h.close();
    }
  });

  it('reports an unindexed file rather than deleting it by default', () => {
    const h = harness(driver);
    try {
      // What a crash between rename and index would leave behind.
      const hash = sha('unindexed');
      mkdirSync(join(h.root, hash.slice(0, 2)), { recursive: true });
      writeFileSync(join(h.root, hash.slice(0, 2), hash), 'unindexed');

      const reported = h.store.gc();
      expect(reported.orphans).toEqual([hash]);
      expect(existsSync(h.store.pathFor(hash))).toBe(true);

      const swept = h.store.gc({ removeOrphans: true });
      expect(swept.orphans).toEqual([hash]);
      expect(existsSync(h.store.pathFor(hash))).toBe(false);
    } finally {
      h.close();
    }
  });

  it('reports an indexed blob whose file has vanished', () => {
    const h = harness(driver);
    try {
      const { hash } = h.store.put('will vanish', MESSAGE);
      rmSync(h.store.pathFor(hash), { force: true });

      const report = h.store.gc();
      expect(report.missing).toEqual([hash]);
      expect(report.removed).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('reclaims abandoned temp files only once they are stale', () => {
    const h = harness(driver);
    try {
      h.store.put('anything');
      const tempDirPath = join(h.root, TEMP_DIRNAME);
      const stale = join(tempDirPath, 'crashed.part');
      const fresh = join(tempDirPath, 'in-flight.part');
      writeFileSync(stale, 'half a blob');
      writeFileSync(fresh, 'still being written');

      const old = new Date('2026-08-17T06:00:00.000Z');
      utimesSync(stale, old, old);

      // The store's clock is 09:00; a one-hour grace period spares the fresh file.
      expect(h.store.sweepTemp(60 * 60 * 1000)).toBe(1);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      h.close();
    }
  });

  it('tidies away shard directories it has emptied', () => {
    const h = harness(driver);
    try {
      const { hash } = h.store.put('lonely');
      const shard = join(h.root, hash.slice(0, 2));
      expect(existsSync(shard)).toBe(true);

      h.store.gc();
      expect(existsSync(shard)).toBe(false);
      expect(existsSync(h.root)).toBe(true);
    } finally {
      h.close();
    }
  });

  it('survives being run twice with nothing left to do', () => {
    const h = harness(driver);
    try {
      h.store.put('transient');
      expect(h.store.gc().removed).toHaveLength(1);
      const second = h.store.gc();
      expect(second.removed).toEqual([]);
      expect(second.orphans).toEqual([]);
      expect(second.missing).toEqual([]);
    } finally {
      h.close();
    }
  });
});

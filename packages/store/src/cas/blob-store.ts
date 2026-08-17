import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SqliteDatabase } from '../sqlite/types';

/** Directory under the data dir that holds the object store. */
export const OBJECTS_DIRNAME = 'objects';

/** In-progress writes live here until they are named by their own hash. */
export const TEMP_DIRNAME = 'tmp';

/** How long an abandoned temp file is left alone before GC reclaims it. */
export const DEFAULT_STALE_TEMP_MS = 60 * 60 * 1000;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SHARD_PATTERN = /^[0-9a-f]{2}$/;

/** Who is holding a blob. `kind` names the table, `id` the row. */
export interface BlobRef {
  readonly kind: string;
  readonly id: string;
}

export interface BlobInfo {
  readonly hash: string;
  readonly bytes: number;
  /** True when byte-identical content was already in the store. */
  readonly deduplicated: boolean;
}

export interface BlobStat {
  readonly hash: string;
  readonly bytes: number;
  readonly createdAt: string;
  readonly refCount: number;
}

export interface GcOptions {
  /** Report what would be removed without removing anything. */
  readonly dryRun?: boolean;
  /**
   * Also delete files that carry no index row at all. Off by default: an
   * unindexed file is far more likely to be a blob mid-write than garbage.
   */
  readonly removeOrphans?: boolean;
  /** Age before an abandoned temp file is reclaimed. */
  readonly staleTempAfterMs?: number;
}

export interface GcReport {
  /** Hashes removed — or, under `dryRun`, the ones that would be. */
  readonly removed: readonly string[];
  readonly removedBytes: number;
  readonly keptCount: number;
  readonly keptBytes: number;
  /** Files present on disk with no index row. */
  readonly orphans: readonly string[];
  /** Indexed blobs whose file has vanished. Never normal; always a warning. */
  readonly missing: readonly string[];
  readonly tempFilesRemoved: number;
}

export class BlobStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BlobStoreError';
  }
}

export class BlobNotFoundError extends BlobStoreError {
  constructor(readonly hash: string) {
    super(`No blob in the object store for ${hash}`);
    this.name = 'BlobNotFoundError';
  }
}

export interface BlobStoreOptions {
  readonly now?: () => Date;
  /** Injectable temp-name source, so a collision can be tested. */
  readonly newTempName?: () => string;
}

type BlobRow = { hash: string; bytes: number; created_at: string };

/**
 * Content-addressed blob store.
 *
 * Objects are named by the SHA-256 of their contents and laid out as
 * `objects/<first two hex chars>/<full digest>`, which keeps any one directory
 * small enough for a filesystem to enumerate. Because the name *is* the hash,
 * three things follow for free: identical content is stored exactly once, a
 * stored object can be re-verified at any time, and a write is idempotent —
 * putting the same bytes twice cannot produce two objects or a partial one.
 *
 * Writes land in `objects/tmp` and are renamed into place only once complete,
 * so a crash mid-write leaves a discardable temp file rather than a truncated
 * object that would answer to a hash it does not have.
 *
 * Liveness is tracked in SQLite, not on disk: `blob_refs` records which row of
 * which table holds each blob, and `gc()` deletes only blobs no row holds. The
 * index and the files can disagree after a crash, so GC reports both kinds of
 * disagreement instead of assuming they cannot happen.
 */
export class BlobStore {
  readonly #db: SqliteDatabase;
  readonly #root: string;
  readonly #tempDir: string;
  readonly #now: () => Date;
  readonly #newTempName: () => string;

  constructor(db: SqliteDatabase, root: string, options: BlobStoreOptions = {}) {
    this.#db = db;
    this.#root = root;
    this.#tempDir = join(root, TEMP_DIRNAME);
    this.#now = options.now ?? (() => new Date());
    this.#newTempName =
      options.newTempName ??
      (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    mkdirSync(this.#root, { recursive: true });
  }

  get root(): string {
    return this.#root;
  }

  /** Where a hash lives, whether or not anything is there yet. */
  pathFor(hash: string): string {
    const normalised = assertHash(hash);
    return join(this.#root, normalised.slice(0, 2), normalised);
  }

  /** True when the object's *file* is present, regardless of the index. */
  hasFile(hash: string): boolean {
    return existsSync(this.pathFor(hash));
  }

  /** True when the object is both on disk and indexed. */
  has(hash: string): boolean {
    return this.hasFile(hash) && this.#row(hash) !== undefined;
  }

  stat(hash: string): BlobStat | undefined {
    const row = this.#row(hash);
    if (!row) return undefined;
    return {
      hash: row.hash,
      bytes: row.bytes,
      createdAt: row.created_at,
      refCount: this.refCount(row.hash),
    };
  }

  count(): number {
    return this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blobs')?.n ?? 0;
  }

  totalBytes(): number {
    return this.#db.get<{ n: number }>('SELECT COALESCE(SUM(bytes), 0) AS n FROM blobs')?.n ?? 0;
  }

  /** Stores bytes or UTF-8 text. Small payloads; use `putStream` for big ones. */
  put(content: Uint8Array | string, ref?: BlobRef): BlobInfo {
    const buffer =
      typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const hash = createHash('sha256').update(buffer).digest('hex');

    // Already there: the content address makes rewriting it pointless.
    if (this.hasFile(hash)) return this.#index(hash, buffer.byteLength, true, ref);

    const tempPath = this.#tempPath();
    mkdirSync(this.#tempDir, { recursive: true });
    writeFileSync(tempPath, buffer);
    return this.#adopt(tempPath, hash, buffer.byteLength, ref);
  }

  /**
   * Streams a source into the store, hashing as it goes.
   *
   * The hash is not known until the last byte arrives, so the data is written
   * under a temporary name and renamed once it can be named correctly. Nothing
   * is ever held entirely in memory.
   */
  async putStream(
    source: Readable | AsyncIterable<Uint8Array | string>,
    ref?: BlobRef,
  ): Promise<BlobInfo> {
    const hasher = createHash('sha256');
    let bytes = 0;

    const measure = new Transform({
      transform(chunk: Uint8Array | string, _encoding, done) {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
        hasher.update(buffer);
        bytes += buffer.byteLength;
        done(null, buffer);
      },
    });

    mkdirSync(this.#tempDir, { recursive: true });
    const tempPath = this.#tempPath();

    try {
      await pipeline(source, measure, createWriteStream(tempPath));
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw new BlobStoreError('could not write a blob to the object store', { cause: error });
    }

    const hash = hasher.digest('hex');
    if (this.hasFile(hash)) {
      rmSync(tempPath, { force: true });
      return this.#index(hash, bytes, true, ref);
    }
    return this.#adopt(tempPath, hash, bytes, ref);
  }

  /** Ingests a file already on disk, e.g. an artifact a sandbox run produced. */
  async putFile(path: string, ref?: BlobRef): Promise<BlobInfo> {
    return this.putStream(createReadStream(path), ref);
  }

  read(hash: string): Uint8Array {
    const normalised = assertHash(hash);
    const path = this.pathFor(normalised);
    if (!existsSync(path)) throw new BlobNotFoundError(normalised);
    return readFileSync(path);
  }

  readText(hash: string): string {
    return Buffer.from(this.read(hash)).toString('utf8');
  }

  /** A stream over the object, for anything too large to hold in memory. */
  openRead(hash: string): Readable {
    const path = this.pathFor(hash);
    if (!existsSync(path)) throw new BlobNotFoundError(hash.toLowerCase());
    return createReadStream(path);
  }

  /**
   * Re-hashes the stored bytes and checks them against the name.
   *
   * The point of content addressing is that this is possible at all: a blob
   * that fails here has been corrupted on disk, and no amount of index
   * bookkeeping would have revealed it.
   */
  verify(hash: string): boolean {
    const normalised = assertHash(hash);
    if (!this.hasFile(normalised)) return false;
    const actual = createHash('sha256')
      .update(readFileSync(this.pathFor(normalised)))
      .digest('hex');
    return actual === normalised;
  }

  /** Records that `ref` holds `hash`. Idempotent. */
  retain(hash: string, ref: BlobRef): void {
    const normalised = assertHash(hash);
    if (this.#row(normalised) === undefined) throw new BlobNotFoundError(normalised);
    assertRef(ref);

    this.#db.run(
      `INSERT INTO blob_refs (hash, ref_kind, ref_id, retained_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(hash, ref_kind, ref_id) DO NOTHING`,
      [normalised, ref.kind, ref.id, this.#now().toISOString()],
    );
  }

  /** Drops one reference. Returns false when that reference was not held. */
  release(hash: string, ref: BlobRef): boolean {
    const normalised = assertHash(hash);
    assertRef(ref);
    const result = this.#db.run(
      'DELETE FROM blob_refs WHERE hash = ? AND ref_kind = ? AND ref_id = ?',
      [normalised, ref.kind, ref.id],
    );
    return result.changes > 0;
  }

  /** Drops every reference held by one owner, e.g. when its row is deleted. */
  releaseAll(ref: BlobRef): number {
    assertRef(ref);
    return this.#db.run('DELETE FROM blob_refs WHERE ref_kind = ? AND ref_id = ?', [
      ref.kind,
      ref.id,
    ]).changes;
  }

  refCount(hash: string): number {
    return (
      this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blob_refs WHERE hash = ?', [
        assertHash(hash),
      ])?.n ?? 0
    );
  }

  refs(hash: string): BlobRef[] {
    return this.#db
      .all<{ ref_kind: string; ref_id: string }>(
        'SELECT ref_kind, ref_id FROM blob_refs WHERE hash = ? ORDER BY ref_kind, ref_id',
        [assertHash(hash)],
      )
      .map((row) => ({ kind: row.ref_kind, id: row.ref_id }));
  }

  /** Which blobs one owner holds. */
  heldBy(ref: BlobRef): string[] {
    assertRef(ref);
    return this.#db
      .all<{ hash: string }>(
        'SELECT hash FROM blob_refs WHERE ref_kind = ? AND ref_id = ? ORDER BY hash',
        [ref.kind, ref.id],
      )
      .map((row) => row.hash);
  }

  /** Every indexed blob, oldest first. */
  list(): BlobStat[] {
    return this.#db
      .all<BlobRow & { refs: number }>(
        `SELECT b.hash, b.bytes, b.created_at,
                (SELECT COUNT(*) FROM blob_refs r WHERE r.hash = b.hash) AS refs
         FROM blobs b ORDER BY b.created_at, b.hash`,
      )
      .map((row) => ({
        hash: row.hash,
        bytes: row.bytes,
        createdAt: row.created_at,
        refCount: row.refs,
      }));
  }

  unreferenced(): BlobStat[] {
    return this.#db
      .all<BlobRow>(
        `SELECT hash, bytes, created_at FROM blobs
         WHERE NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.hash = blobs.hash)
         ORDER BY created_at, hash`,
      )
      .map((row) => ({
        hash: row.hash,
        bytes: row.bytes,
        createdAt: row.created_at,
        refCount: 0,
      }));
  }

  /**
   * Deletes blobs nothing refers to, and nothing else.
   *
   * Index rows go first, inside a transaction, and files are unlinked
   * afterwards. That order is deliberate: interrupted halfway it leaves an
   * unreferenced *file*, which the next sweep reclaims, rather than a live row
   * pointing at a file that no longer exists.
   */
  gc(options: GcOptions = {}): GcReport {
    const dryRun = options.dryRun === true;
    const candidates = this.unreferenced();
    const removed = candidates.map((blob) => blob.hash);
    const removedBytes = candidates.reduce((total, blob) => total + blob.bytes, 0);

    if (!dryRun && candidates.length > 0) {
      this.#db.transaction(() => {
        for (const blob of candidates) {
          this.#db.run('DELETE FROM blobs WHERE hash = ?', [blob.hash]);
        }
      });

      for (const blob of candidates) rmSync(this.pathFor(blob.hash), { force: true });
      this.#pruneEmptyShards();
    }

    const indexed = new Set(
      this.#db.all<{ hash: string }>('SELECT hash FROM blobs').map((row) => row.hash),
    );
    const onDisk = new Set(this.#diskHashes());

    const orphans = [...onDisk].filter((hash) => !indexed.has(hash)).sort();
    const missing = [...indexed].filter((hash) => !onDisk.has(hash)).sort();

    if (options.removeOrphans === true && !dryRun) {
      for (const hash of orphans) rmSync(this.pathFor(hash), { force: true });
      this.#pruneEmptyShards();
    }

    return {
      removed,
      removedBytes,
      keptCount: indexed.size,
      keptBytes: this.totalBytes(),
      orphans,
      missing,
      tempFilesRemoved: dryRun ? 0 : this.sweepTemp(options.staleTempAfterMs),
    };
  }

  /** Reclaims writes abandoned by a crash. Recent temp files are left alone. */
  sweepTemp(staleAfterMs = DEFAULT_STALE_TEMP_MS): number {
    if (!existsSync(this.#tempDir)) return 0;
    const cutoff = this.#now().getTime() - staleAfterMs;
    let removed = 0;

    for (const name of readdirSync(this.#tempDir)) {
      const path = join(this.#tempDir, name);
      try {
        if (statSync(path).mtimeMs > cutoff) continue;
        rmSync(path, { force: true });
        removed += 1;
      } catch {
        // Vanished under us, or is not ours to remove. Either way, not an error.
      }
    }
    return removed;
  }

  #tempPath(): string {
    return join(this.#tempDir, `${this.#newTempName()}.part`);
  }

  /** Moves a completed temp file to its content address and indexes it. */
  #adopt(tempPath: string, hash: string, bytes: number, ref?: BlobRef): BlobInfo {
    const target = this.pathFor(hash);
    mkdirSync(dirname(target), { recursive: true });

    try {
      renameSync(tempPath, target);
    } catch (error) {
      // A rename can only lose to an object of the same name, which by
      // construction has the same contents.
      rmSync(tempPath, { force: true });
      if (!existsSync(target)) {
        throw new BlobStoreError(`could not store blob ${hash}`, { cause: error });
      }
      return this.#index(hash, bytes, true, ref);
    }

    return this.#index(hash, bytes, false, ref);
  }

  /** Ensures the index row exists, then applies an optional first reference. */
  #index(hash: string, bytes: number, deduplicated: boolean, ref?: BlobRef): BlobInfo {
    this.#db.transaction(() => {
      this.#db.run(
        `INSERT INTO blobs (hash, bytes, created_at) VALUES (?, ?, ?)
         ON CONFLICT(hash) DO NOTHING`,
        [hash, bytes, this.#now().toISOString()],
      );
      if (ref) this.retain(hash, ref);
    });
    return { hash, bytes, deduplicated };
  }

  #row(hash: string): BlobRow | undefined {
    return this.#db.get<BlobRow>('SELECT hash, bytes, created_at FROM blobs WHERE hash = ?', [
      assertHash(hash),
    ]);
  }

  /** Every well-formed object name found under the shard directories. */
  *#diskHashes(): Generator<string> {
    if (!existsSync(this.#root)) return;
    for (const shard of readdirSync(this.#root)) {
      if (!SHARD_PATTERN.test(shard)) continue;
      for (const name of readdirSync(join(this.#root, shard))) {
        if (HASH_PATTERN.test(name) && name.startsWith(shard)) yield name;
      }
    }
  }

  #pruneEmptyShards(): void {
    for (const shard of readdirSync(this.#root)) {
      if (!SHARD_PATTERN.test(shard)) continue;
      const path = join(this.#root, shard);
      try {
        if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
      } catch {
        // Racing with a write into the same shard; leaving it is harmless.
      }
    }
  }
}

function assertHash(hash: string): string {
  const normalised = hash.toLowerCase();
  if (!HASH_PATTERN.test(normalised)) {
    throw new BlobStoreError(`not a sha-256 content address: ${hash}`);
  }
  return normalised;
}

function assertRef(ref: BlobRef): void {
  if (ref.kind.trim() === '') throw new BlobStoreError('a blob reference needs a kind');
  if (ref.id.trim() === '') throw new BlobStoreError('a blob reference needs an id');
}

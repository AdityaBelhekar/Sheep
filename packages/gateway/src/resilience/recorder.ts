import { createHash } from 'node:crypto';
import type { Delta, StopReason, TokenUsage } from '../delta';
import type { NormalizedRequest } from '../request';

/**
 * Every exchange, kept by hash.
 *
 * P5 says reproducibility is a build artifact: a session must replay from what
 * was actually stored, not from a re-run of the model. So both halves of every
 * call go into the content-addressed store — the request as it was sent, and
 * the whole delta transcript as it arrived, including a transcript that stops
 * in the middle because the provider fell over. That last case is what "without
 * data loss" means: the tokens were paid for, so they are kept.
 *
 * Dedupe is free and load-bearing. Six models sent the same system prompt is
 * one blob, and a retry that re-sends an identical request adds nothing.
 */

/**
 * The slice of Phase 7's `BlobStore` this needs.
 *
 * An interface, not an import: the gateway must stay runnable without SQLite —
 * tests, and eventually a headless mode — and the store already has exactly
 * this shape, so nothing has to be adapted at the call site.
 */
export interface BlobPut {
  put(content: Uint8Array | string): { hash: string; bytes: number };
}

/** What one call cost and produced, with both blobs addressed by hash. */
export interface ExchangeRecord {
  readonly adapterId: string;
  readonly modelId: string;
  /** Hash of the recorded request document. */
  readonly requestHash: string;
  /** Hash of the JSONL delta transcript. */
  readonly transcriptHash: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** 1 when it worked first time. */
  readonly attempts: number;
  readonly deltaCount: number;
  readonly usage: TokenUsage | null;
  readonly stopReason: StopReason | null;
  /** True when the stream ended early; the transcript is what survived. */
  readonly partial: boolean;
  readonly error?: { readonly name: string; readonly message: string };
}

export interface RecordedRequest {
  readonly adapterId: string;
  readonly vendorId: string;
  /** The vendor-neutral request — what replay needs to reissue the call. */
  readonly request: NormalizedRequest;
  /** The provider's own body, when the adapter can produce it. */
  readonly wire?: unknown;
}

/**
 * Writes the two blobs and hands back the record.
 *
 * Deliberately not a class with state: a recorder that accumulated anything
 * would be one more thing to flush before a crash, and the whole point is that
 * the bytes are already durable when the call returns.
 */
export class ExchangeRecorder {
  readonly #blobs: BlobPut;
  readonly #now: () => Date;

  constructor(blobs: BlobPut, options: { now?: () => Date } = {}) {
    this.#blobs = blobs;
    this.#now = options.now ?? (() => new Date());
  }

  now(): string {
    return this.#now().toISOString();
  }

  putRequest(recorded: RecordedRequest): string {
    return this.#blobs.put(canonicalJson(recorded)).hash;
  }

  /** One delta per line, in arrival order — a transcript, not a summary. */
  putTranscript(deltas: readonly Delta[]): string {
    return this.#blobs.put(deltas.map((delta) => JSON.stringify(delta)).join('\n')).hash;
  }
}

/**
 * Reads a transcript back as a stream of deltas.
 *
 * The same shape a live call produces, so replay and playback are the same code
 * path everywhere above the gateway — a session rendered from CAS and a session
 * rendered live cannot drift, because nothing downstream can tell them apart.
 */
export function replayTranscript(text: string): Delta[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Delta);
}

export async function* replayDeltas(text: string): AsyncGenerator<Delta, void, undefined> {
  for (const delta of replayTranscript(text)) yield delta;
}

/**
 * Stable key order, so the same request hashes to the same address.
 *
 * `JSON.stringify` preserves insertion order, and two callers that built the
 * same request in a different order would otherwise store two copies of it and
 * defeat the dedupe this whole design rests on.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key]);
  return sorted;
}

/** The address a payload would get, without storing it. */
export function hashOf(content: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
    .digest('hex');
}

/** A `BlobPut` in memory, for tests and for a session that must not persist. */
export function memoryBlobStore(): BlobPut & {
  read(hash: string): string | undefined;
  readonly size: number;
} {
  const blobs = new Map<string, string>();
  return {
    put(content) {
      const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
      const hash = hashOf(text);
      blobs.set(hash, text);
      return { hash, bytes: Buffer.byteLength(text, 'utf8') };
    },
    read: (hash) => blobs.get(hash),
    get size() {
      return blobs.size;
    },
  };
}

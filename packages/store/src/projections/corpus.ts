import type { DomainEvent, DomainEventType } from '@sheep/core';
import type { EventRecord } from '../events/log';
import type { SqliteDatabase } from '../sqlite/types';
import type { Projection } from './types';

/**
 * The vector index over a session's corpus: every turn, every claim and every
 * retrieved source, as a vector that can be compared with any other.
 *
 * It is a projection. The vectors are computed from text that is already in
 * the log, by a function with no state and no model behind it, so the whole
 * index can be dropped and rebuilt and comes back the same. Nothing here is a
 * record of anything; it is a faster way to ask the log what it contains.
 *
 * The vectors are hashed n-grams, not a learned embedding. Each word and each
 * adjacent pair of words is hashed to one of `DIMENSIONS` coordinates, weighted
 * by how often it occurs, and the result is normalised. Two texts are close
 * when they share vocabulary and phrasing — which finds the same paper from
 * two providers, a hypothesis stated twice, and the turns that discuss a term
 * — and not when they say the same thing in different words. That ceiling is
 * the price of an index with no model to download, no key and no call out;
 * replacing `embed` with a model's vectors changes nothing else in this file.
 *
 * ponytail: search reads every vector of the session and compares in
 * JavaScript. Exact, and immediate for the thousands of rows a session has.
 * Past a few hundred thousand, move the comparison into SQLite (sqlite-vec),
 * which needs the native driver.
 */

export const CORPUS_KINDS = ['message', 'claim', 'source'] as const;
export type CorpusKind = (typeof CORPUS_KINDS)[number];

/** How many coordinates a vector has. Enough that two unrelated words rarely share one. */
export const DIMENSIONS = 512;

/** The most text one row is embedded from, and the most of it kept to show. */
const MAX_EMBEDDED = 20_000;
const PREVIEW = 400;

/** Too common to tell two texts apart; left out so they do not dominate the pairs. */
const STOP_WORDS: ReadonlySet<string> = new Set(
  'a an and are as at be by for from has have in is it its of on or that the this to was we were which with'.split(
    ' ',
  ),
);

/** FNV-1a: small, fast, and the same on every machine. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/**
 * A text as a unit vector.
 *
 * The sign of each feature comes from a second bit of its hash, so that two
 * features landing on one coordinate cancel as often as they add, instead of
 * always inflating it.
 */
export function embed(text: string): Float32Array {
  const words = text
    .slice(0, MAX_EMBEDDED)
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));

  const counts = new Map<string, number>();
  const count = (feature: string): void => {
    counts.set(feature, (counts.get(feature) ?? 0) + 1);
  };
  words.forEach((word, index) => {
    count(word);
    const next = words[index + 1];
    if (next !== undefined) count(`${word} ${next}`);
  });

  const vector = new Float32Array(DIMENSIONS);
  for (const [feature, occurrences] of counts) {
    const hashed = hash(feature);
    const sign = (hashed & 0x8000_0000) === 0 ? 1 : -1;
    vector[hashed % DIMENSIONS]! += sign * (1 + Math.log(occurrences));
  }

  let length = 0;
  for (const value of vector) length += value * value;
  length = Math.sqrt(length);
  if (length > 0) for (let index = 0; index < DIMENSIONS; index += 1) vector[index]! /= length;
  return vector;
}

/** How alike two unit vectors are: 1 for the same direction, 0 for nothing shared. */
export function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let index = 0; index < DIMENSIONS; index += 1) dot += a[index]! * b[index]!;
  return dot;
}

export const CORPUS_DDL = `
  CREATE TABLE IF NOT EXISTS corpus (
    kind       TEXT NOT NULL,
    ref_id     TEXT NOT NULL,
    session_id TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    preview    TEXT NOT NULL,
    vector     BLOB NOT NULL,
    PRIMARY KEY (kind, ref_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS corpus_session_idx ON corpus (session_id, kind, seq);
`;

const toBlob = (vector: Float32Array): Uint8Array =>
  new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);

/** A copy, so the vector is aligned whatever offset the driver's buffer had. */
const fromBlob = (blob: Uint8Array): Float32Array =>
  new Float32Array(blob.slice().buffer, 0, DIMENSIONS);

export const CORPUS_PROJECTION: Projection = {
  name: 'corpus',
  ddlVersion: 1,
  tables: ['corpus'],
  ddl: CORPUS_DDL,

  handles(type: DomainEventType): boolean {
    return (
      type === 'message.recorded' || type === 'claim.recorded' || type === 'retrieval.recorded'
    );
  },

  apply(db: SqliteDatabase, event: DomainEvent, record: EventRecord): void {
    const index = (kind: CorpusKind, refId: string, sessionId: string, text: string): void => {
      if (text.trim() === '') return;
      // OR REPLACE: a rebuild replays events the table may already reflect.
      db.run(
        `INSERT OR REPLACE INTO corpus (kind, ref_id, session_id, seq, preview, vector)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          kind,
          refId,
          sessionId,
          record.seq,
          text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW),
          toBlob(embed(text)),
        ],
      );
    };

    switch (event.type) {
      case 'message.recorded': {
        const { body, messageId, sessionId } = event.payload;
        if (body.kind === 'text') index('message', messageId, sessionId, body.text);
        return;
      }
      case 'claim.recorded':
        index('claim', event.payload.claimId, event.payload.sessionId, event.payload.statement);
        return;
      case 'retrieval.recorded':
        for (const source of event.payload.sources) {
          index(
            'source',
            source.sourceId,
            event.payload.sessionId,
            `${source.title}\n${source.abstract ?? ''}`,
          );
        }
        return;
      default:
        return;
    }
  },
};

export interface CorpusHit {
  readonly kind: CorpusKind;
  /** A message id, a claim id or a source id, by `kind`. */
  readonly refId: string;
  /** The start of the text, on one line. */
  readonly preview: string;
  /** Cosine similarity to the query, 0–1 in practice. */
  readonly score: number;
}

type CorpusRow = { kind: string; ref_id: string; preview: string; vector: Uint8Array };

function rows(db: SqliteDatabase, sessionId: string, kinds: readonly CorpusKind[]): CorpusRow[] {
  return db.all<CorpusRow>(
    `SELECT kind, ref_id, preview, vector FROM corpus
     WHERE session_id = ? AND kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY seq, ref_id`,
    [sessionId, ...kinds],
  );
}

/** Anything scoring below this shares so little with the query that listing it would be noise. */
const MIN_SCORE = 0.05;

/**
 * The rows of a session closest to a query, best first.
 *
 * An empty result means nothing in the session shares the query's words, and
 * is returned as empty rather than padded with the least bad.
 */
export function searchCorpus(
  db: SqliteDatabase,
  sessionId: string,
  query: string,
  options: { readonly limit?: number; readonly kinds?: readonly CorpusKind[] } = {},
): CorpusHit[] {
  const target = embed(query);
  return rows(db, sessionId, options.kinds ?? CORPUS_KINDS)
    .map((row) => ({
      kind: row.kind as CorpusKind,
      refId: row.ref_id,
      preview: row.preview,
      score: similarity(target, fromBlob(row.vector)),
    }))
    .filter((hit) => hit.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 10);
}

/**
 * Groups a session's rows of one kind by closeness.
 *
 * At a high threshold the groups are duplicates — the same paper returned by
 * two providers, a hypothesis recorded twice. Lower, they are topics. Every
 * row is in exactly one group, in the order it entered the log; a row close
 * to none is a group of one. Single-link against each group's first member,
 * so the result does not depend on anything but the log.
 */
export function clusterCorpus(
  db: SqliteDatabase,
  sessionId: string,
  kind: CorpusKind,
  threshold = 0.85,
): string[][] {
  const groups: { first: Float32Array; members: string[] }[] = [];
  for (const row of rows(db, sessionId, [kind])) {
    const vector = fromBlob(row.vector);
    let best: (typeof groups)[number] | undefined;
    let bestScore = threshold;
    for (const group of groups) {
      const score = similarity(vector, group.first);
      if (score >= bestScore) {
        best = group;
        bestScore = score;
      }
    }
    if (best) best.members.push(row.ref_id);
    else groups.push({ first: vector, members: [row.ref_id] });
  }
  return groups.map((group) => group.members);
}

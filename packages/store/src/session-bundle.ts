import { createHash } from 'node:crypto';
import { safeParseDomainEvent } from '@sheep/core';
import { z } from 'zod';
import { ArchiveError, unzip, zip, type ArchiveFile } from './archive';
import type { BlobRef } from './cas/blob-store';
import { hashPayload } from './events/hash';
import { parseJson, type JsonValue } from './events/json';
import { getSession } from './projections/sessions';
import type { SheepStore } from './store';

/**
 * A session, as one file that can be carried to another machine.
 *
 * A session is its events and the blobs they name; everything else Sheep shows
 * is derived from those. So a bundle holds exactly that — every event of the
 * session in order, and every blob an event refers to — and importing one is
 * appending those events to another log, where the projections rebuild what
 * the first machine showed.
 *
 * A bundle comes from outside and is believed about nothing. Each event must
 * hash to the payload hash it carries, parse as an event this build knows, and
 * belong to the one session the bundle says it is; each blob must hash to its
 * own name. The events then go through the same ledger rules as when they were
 * first written, so a bundle cannot introduce a claim the ledger would have
 * refused. What cannot be carried is the first machine's hash chain: entries
 * are chained to whatever log they are appended to. The bundle states the
 * chain head it was exported at, and the import is a new entry in a new chain.
 */

export const SESSION_BUNDLE_FORMAT = 'sheep-session/1';

/** The file extension a bundle is saved with, and the one Sheep is registered to open. */
export const SESSION_BUNDLE_EXTENSION = 'sheep';

/** A session larger than this is not one a bundle is for: 1 GB unpacked, 50,000 files. */
const LIMITS = { maxEntries: 50_000, maxBytes: 1_024 * 1_024 * 1_024 };

const HASH = /^[0-9a-f]{64}$/;

export class SessionBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionBundleError';
  }
}

const manifestSchema = z.object({
  format: z.literal(SESSION_BUNDLE_FORMAT),
  sessionId: z.uuid(),
  title: z.string(),
  question: z.string(),
  events: z.number().int().positive(),
  blobs: z.array(z.string().regex(HASH)),
  /** The exporting log's head when the bundle was written. Stated, not verifiable from here. */
  exportedAt: z.object({ seq: z.number().int(), rootHash: z.string().regex(HASH) }),
});
export type SessionBundleManifest = z.infer<typeof manifestSchema>;

const entrySchema = z.object({
  eventId: z.uuid(),
  type: z.string().min(1),
  payload: z.unknown(),
  recordedAt: z.iso.datetime(),
  payloadHash: z.string().regex(HASH),
});

/** Every content address anywhere in a payload. */
function hashesIn(value: unknown, found: Set<string>): void {
  if (typeof value === 'string') {
    if (HASH.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) hashesIn(item, found);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) hashesIn(item, found);
  }
}

/** Who holds an imported session's blobs. */
export function sessionBlobRef(sessionId: string): BlobRef {
  return { kind: 'session', id: sessionId };
}

/**
 * Writes a session to a bundle.
 *
 * Which blobs belong to a session is not looked up record by record: any
 * content address that appears anywhere in the session's events and names a
 * blob in the store is taken. A new kind of record is therefore exported
 * correctly the day it is added, without this function hearing about it.
 */
export function exportSession(store: SheepStore, sessionId: string): Uint8Array {
  const session = getSession(store.db, sessionId);
  if (!session) throw new SessionBundleError(`unknown session: ${sessionId}`);
  const head = store.events.head();
  const records = [...store.events.stream({ sessionId })];
  if (!head || records.length === 0) throw new SessionBundleError('the session has no events');

  const named = new Set<string>();
  for (const record of records) hashesIn(record.payload, named);
  const blobs = [...named].filter((hash) => store.blobs.hasFile(hash)).sort();

  const manifest: SessionBundleManifest = {
    format: SESSION_BUNDLE_FORMAT,
    sessionId,
    title: session.title,
    question: session.question,
    events: records.length,
    blobs,
    exportedAt: { seq: head.seq, rootHash: head.entryHash },
  };
  const files: ArchiveFile[] = [
    { path: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` },
    {
      path: 'events.jsonl',
      data: records
        .map(
          ({ eventId, type, payload, recordedAt, payloadHash }) =>
            `${JSON.stringify({ eventId, type, payload, recordedAt, payloadHash })}\n`,
        )
        .join(''),
    },
    ...blobs.map((hash) => ({ path: `blobs/${hash}`, data: store.blobs.read(hash) })),
  ];
  return zip(files);
}

export interface ImportedSession {
  readonly sessionId: string;
  readonly title: string;
  readonly events: number;
  readonly blobs: number;
}

/**
 * Reads a bundle without importing it: everything that can be checked about
 * it on its own is checked here, and nothing is written.
 */
function readBundle(archive: Uint8Array): {
  manifest: SessionBundleManifest;
  events: z.infer<typeof entrySchema>[];
  blobs: Map<string, Uint8Array>;
} {
  let files: Map<string, Uint8Array>;
  try {
    files = unzip(archive, LIMITS);
  } catch (error) {
    if (error instanceof ArchiveError) throw new SessionBundleError(error.message);
    throw error;
  }
  const text = (path: string): string => {
    const data = files.get(path);
    if (!data) throw new SessionBundleError(`this is not a Sheep session: it has no ${path}`);
    return Buffer.from(data).toString('utf8');
  };

  let manifest: SessionBundleManifest;
  let events: z.infer<typeof entrySchema>[];
  try {
    manifest = manifestSchema.parse(JSON.parse(text('manifest.json')));
    events = text('events.jsonl')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => entrySchema.parse(parseJson(line)));
  } catch (error) {
    if (error instanceof SessionBundleError) throw error;
    throw new SessionBundleError('this is not a Sheep session this version can read');
  }

  if (events.length !== manifest.events) {
    throw new SessionBundleError(
      `the bundle says it holds ${String(manifest.events)} events and holds ${String(events.length)}`,
    );
  }
  events.forEach((entry, index) => {
    const where = `event ${String(index + 1)}`;
    if (hashPayload(entry.payload as JsonValue) !== entry.payloadHash) {
      throw new SessionBundleError(`${where} is not what its hash says it is`);
    }
    const parsed = safeParseDomainEvent(entry.type, entry.payload);
    if (!parsed.ok) {
      throw new SessionBundleError(`${where} (${entry.type}) is not an event this version knows`);
    }
    // Every event names the one session. A bundle cannot write into another, or into none.
    const owner = (entry.payload as { sessionId?: unknown } | null)?.sessionId;
    if (owner !== manifest.sessionId) {
      throw new SessionBundleError(`${where} belongs to a different session than the bundle`);
    }
  });
  if (events[0]?.type !== 'session.created') {
    throw new SessionBundleError('the bundle does not begin with the creation of its session');
  }

  const blobs = new Map<string, Uint8Array>();
  for (const hash of manifest.blobs) {
    const data = files.get(`blobs/${hash}`);
    if (!data) throw new SessionBundleError(`the bundle is missing blob ${hash}`);
    if (createHash('sha256').update(data).digest('hex') !== hash) {
      throw new SessionBundleError(`blob ${hash} is not what its name says it is`);
    }
    blobs.set(hash, data);
  }
  const expected = 2 + manifest.blobs.length;
  if (files.size !== expected) {
    throw new SessionBundleError('the bundle holds files a session bundle does not have');
  }
  return { manifest, events, blobs };
}

/**
 * Imports a bundle into this store.
 *
 * All or nothing: the events are appended in one transaction, through the
 * ledger's rules, with the ids and times they were first recorded with. If
 * anything refuses them, the blobs written for them are released again and
 * the store is as it was. A session that is already here is not imported over.
 */
export function importSession(store: SheepStore, archive: Uint8Array): ImportedSession {
  const { manifest, events, blobs } = readBundle(archive);
  if (getSession(store.db, manifest.sessionId)) {
    throw new SessionBundleError(
      `this session is already here: “${manifest.title}”. A session is imported once.`,
    );
  }

  const ref = sessionBlobRef(manifest.sessionId);
  try {
    for (const data of blobs.values()) store.blobs.put(Buffer.from(data), ref);
    store.record(
      events.map((entry) => ({
        type: entry.type,
        payload: entry.payload as JsonValue,
        eventId: entry.eventId,
        recordedAt: entry.recordedAt,
      })),
    );
  } catch (error) {
    store.blobs.releaseAll(ref);
    if (error instanceof SessionBundleError) throw error;
    throw new SessionBundleError(
      `the session could not be imported: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    sessionId: manifest.sessionId,
    title: manifest.title,
    events: events.length,
    blobs: blobs.size,
  };
}

import { createHash } from 'node:crypto';
import { canonicalJson, type JsonValue } from './json';

/** `prev_hash` of the first entry: there is nothing before it. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * ASCII unit separator. Joining on a character that cannot appear in an id,
 * type name, timestamp or hex digest keeps field boundaries unambiguous, so no
 * two different entries can hash the same string.
 */
const FIELD_SEPARATOR = '\u001f';

export interface HashableEntry {
  readonly seq: number;
  readonly eventId: string;
  readonly sessionId: string | null;
  readonly type: string;
  readonly recordedAt: string;
  readonly payloadHash: string;
  readonly prevHash: string;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashPayload(payload: JsonValue): string {
  return sha256Hex(canonicalJson(payload));
}

/**
 * Hash over everything the entry commits to, including its position and the
 * previous entry's hash. Changing any field — or reordering entries — changes
 * this value and every value after it.
 */
export function hashEntry(entry: HashableEntry): string {
  return sha256Hex(
    [
      String(entry.seq),
      entry.eventId,
      entry.sessionId ?? '',
      entry.type,
      entry.recordedAt,
      entry.payloadHash,
      entry.prevHash,
    ].join(FIELD_SEPARATOR),
  );
}

import { safeParseDomainEvent, type DomainEvent } from '@sheep/core';
import type { LoggedEvent, PaperSource } from '@sheep/paper';
import {
  claimsOnArtifacts,
  getSession,
  listArtifacts,
  listDerivations,
  listExecutions,
  listMessages,
  listParticipants,
  listSources,
  readLedger,
  type SheepStore,
} from '@sheep/store';

/** More turns than a session has; the default page is for a screen, not a paper. */
const EVERY_MESSAGE = 100_000;

/**
 * Everything a paper is compiled from, read out of the store at one moment.
 *
 * Electron-free, like the protocol services, so the end-to-end test compiles a
 * paper from a real session through this same function. Nothing is decided
 * here: it reads the log, the ledger and the projections, and hands them over.
 */
export function readPaperSource(store: SheepStore, sessionId: string): PaperSource {
  const session = getSession(store.db, sessionId);
  if (!session) throw new Error(`unknown session: ${sessionId}`);

  const events: DomainEvent[] = [];
  for (const record of store.events.stream({ sessionId })) {
    const parsed = safeParseDomainEvent(record.type, record.payload);
    // An entry this build cannot read is left out, as every other reader does.
    if (parsed.ok) events.push(parsed.event);
  }

  const ledger = readLedger(store.events, sessionId);
  const artifacts = listArtifacts(store.db, sessionId);
  const backing = claimsOnArtifacts(ledger, artifacts);
  return {
    sessionId,
    title: session.title,
    question: session.question,
    // Detached models too: a finding's author is named whether or not it stayed.
    roster: listParticipants(store.db, sessionId),
    events,
    ledger,
    artifacts: artifacts.map((record) => ({
      record,
      claimIds: backing.get(record.artifactId) ?? [],
    })),
    executions: listExecutions(store.db, sessionId),
    derivations: listDerivations(store.db, sessionId),
    messages: listMessages(store.db, sessionId, { limit: EVERY_MESSAGE }),
    sources: listSources(store.db, sessionId),
    head: store.events.head() ?? null,
    read: (hash) => store.blobs.read(hash),
  };
}

/**
 * The session's entries of the event log, with the hashes that chain them.
 *
 * The chain runs through every session in the store, so these entries alone do
 * not re-verify it end to end; each still carries the hash of its own payload.
 */
export function readSessionLog(store: SheepStore, sessionId: string): LoggedEvent[] {
  return [...store.events.stream({ sessionId })].map((record) => ({
    seq: record.seq,
    type: record.type,
    payload: record.payload,
    recordedAt: record.recordedAt,
    payloadHash: record.payloadHash,
    prevHash: record.prevHash,
    entryHash: record.entryHash,
  }));
}

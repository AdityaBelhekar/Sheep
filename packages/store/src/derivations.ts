import {
  derivationSchema,
  derivationVerdictSchema,
  domainEvent,
  LedgerError,
  type Derivation,
  type DerivationRecord,
  type DerivationVerdict,
} from '@sheep/core';
import type { BlobRef } from './cas/blob-store';
import { getDerivation } from './projections/derivations';
import type { SheepStore } from './store';

/** Who holds a derivation's blobs. Releasing it frees them for collection. */
export function derivationBlobRef(derivationId: string): BlobRef {
  return { kind: 'derivation', id: derivationId };
}

/**
 * Makes a checked derivation permanent: the derivation and its verdict go into
 * the content-addressed store, and one `derivation.recorded` event names both
 * and carries the outcome.
 *
 * The same order and the same rollback as an execution record: bytes before
 * the event, so the log never names a blob that is not there, and released
 * again if the event is refused.
 */
export function recordDerivation(
  store: SheepStore,
  input: {
    readonly sessionId: string;
    readonly derivationId: string;
    readonly derivation: Derivation;
    readonly verdict: DerivationVerdict;
    /** The runtime that did the checking. */
    readonly envLockHash: string;
  },
): DerivationRecord {
  const { derivationId, derivation, verdict } = input;
  // Checked before anything is stored: the rollback below releases whatever
  // this id holds, which must never be an earlier derivation's blobs.
  if (getDerivation(store.db, derivationId)) {
    throw new LedgerError('DUPLICATE_DERIVATION', `derivation ${derivationId} is already recorded`);
  }

  const ref = derivationBlobRef(derivationId);
  try {
    store.record([
      domainEvent('derivation.recorded', {
        sessionId: input.sessionId,
        derivationId,
        bodyHash: store.blobs.put(JSON.stringify(derivation), ref).hash,
        verdictHash: store.blobs.put(JSON.stringify(verdict), ref).hash,
        status: verdict.status,
        counts: verdict.counts,
        envLockHash: input.envLockHash,
        ...(derivation.title === undefined ? {} : { title: derivation.title }),
      }),
    ]);
  } catch (error) {
    store.blobs.releaseAll(ref);
    throw error;
  }

  const recorded = getDerivation(store.db, derivationId);
  if (!recorded) throw new Error(`derivation ${derivationId} was recorded but not projected`);
  return recorded;
}

/** A recorded derivation with what was checked and what the checker said. */
export function readDerivation(
  store: SheepStore,
  derivationId: string,
): { record: DerivationRecord; derivation: Derivation; verdict: DerivationVerdict } | undefined {
  const record = getDerivation(store.db, derivationId);
  if (!record) return undefined;
  return {
    record,
    derivation: derivationSchema.parse(JSON.parse(store.blobs.readText(record.bodyHash))),
    verdict: derivationVerdictSchema.parse(JSON.parse(store.blobs.readText(record.verdictHash))),
  };
}

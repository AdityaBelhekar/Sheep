import { randomUUID } from 'node:crypto';
import type { IpcRequest, IpcResponse } from '@sheep/ipc';
import {
  getSession,
  listDerivations,
  readDerivation,
  readLedger,
  recordDerivation,
} from '@sheep/store';
import { Verifier } from '@sheep/verify';
import { getSandbox } from './lab';
import { getStore } from './store';

/**
 * The Verification pane's side of the checkers.
 *
 * A derivation is checked in the sandbox and recorded with its verdict before
 * anything is returned, whatever the verdict was. What the pane shows is
 * therefore always a record: it has an id a `DERIVED` claim can cite, and the
 * ledger already knows whether it may.
 */
export async function checkDerivation(
  request: IpcRequest<'sheep:derivation-check'>,
): Promise<IpcResponse<'sheep:derivation-check'>> {
  const store = getStore();
  if (!getSession(store.db, request.sessionId)) {
    throw new Error(`unknown session: ${request.sessionId}`);
  }

  const sandbox = getSandbox();
  const [verdict] = await new Verifier(sandbox).checkDerivations([request.derivation]);
  if (!verdict) throw new Error('the checker returned no verdict');

  const record = recordDerivation(store, {
    sessionId: request.sessionId,
    derivationId: randomUUID(),
    derivation: request.derivation,
    verdict,
    envLockHash: sandbox.runtime.lockHash,
  });
  return { record, derivation: request.derivation, verdict };
}

export function getDerivationDetail(derivationId: string): IpcResponse<'sheep:derivation-get'> {
  const detail = readDerivation(getStore(), derivationId);
  if (!detail) throw new Error(`unknown derivation: ${derivationId}`);
  return detail;
}

/** A session's derivations, and the claims that rest on each. */
export function readDerivations(sessionId: string): IpcResponse<'sheep:derivations-list'> {
  const store = getStore();
  const backing = new Map<string, string[]>();
  for (const claim of readLedger(store.events, sessionId).claims()) {
    for (const evidence of claim.support) {
      if (evidence.kind !== 'DERIVATION') continue;
      backing.set(evidence.ref, [...(backing.get(evidence.ref) ?? []), claim.claimId]);
    }
  }
  const derivations = listDerivations(store.db, sessionId);
  return {
    derivations,
    backing: derivations.flatMap(({ derivationId }) => {
      const claimIds = backing.get(derivationId);
      return claimIds ? [{ derivationId, claimIds }] : [];
    }),
  };
}

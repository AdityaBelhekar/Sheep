import { describe, expect, it } from 'vitest';
import { domainEvent, type Derivation, type DerivationVerdict } from '@sheep/core';
import { CLAIM_ID, DERIVATION_ID, SESSION_ID } from '@sheep/core/fixtures';
import { derivationBlobRef, readDerivation, recordDerivation } from './derivations';
import { getDerivation, listDerivations } from './projections/derivations';
import { openSheepStore, type SheepStore } from './store';
import { TESTABLE_DRIVERS, useTempDir } from './test-support';

const tempDir = useTempDir('sheep-derivations-');

const OTHER_DERIVATION = 'ffffffff-ffff-4fff-8fff-fffffffffff2';
const LOCK = 'a'.repeat(64);

const DERIVATION: Derivation = {
  title: 'Kinetic energy',
  given: [{ id: 'g1', statement: 'W = F*d' }],
  steps: [{ id: 's1', statement: 'F*d = W', operation: 'rewrite' }],
};

function verdict(status: DerivationVerdict['status']): DerivationVerdict {
  const blank = { latex: null, mathml: null, dimensions: null };
  return {
    status,
    counts: {
      pass: status === 'PASS' ? 1 : 0,
      fail: status === 'FAIL' ? 1 : 0,
      uncheckable: status === 'UNCHECKABLE' ? 1 : 0,
    },
    given: [{ id: 'g1', problem: null, ...blank }],
    steps: [
      { id: 's1', status, reason: 'because', method: 'symbolic', counterexample: null, ...blank },
    ],
  };
}

function withSession(dir: string, driver: (typeof TESTABLE_DRIVERS)[number]): SheepStore {
  const store = openSheepStore({ dataDir: dir, driver });
  store.record([
    domainEvent('session.created', {
      sessionId: SESSION_ID,
      title: 'Sparse attention',
      question: 'Does block-sparse attention preserve perplexity?',
    }),
  ]);
  return store;
}

const record = (store: SheepStore, status: DerivationVerdict['status'], id = DERIVATION_ID) =>
  recordDerivation(store, {
    sessionId: SESSION_ID,
    derivationId: id,
    derivation: DERIVATION,
    verdict: verdict(status),
    envLockHash: LOCK,
  });

const derivedClaim = (ref: string, claimId = CLAIM_ID) =>
  domainEvent('claim.recorded', {
    sessionId: SESSION_ID,
    claimId,
    claimType: 'DERIVED',
    statement: 'Work done equals force times distance.',
    support: [{ kind: 'DERIVATION', ref }],
  });

describe.each(TESTABLE_DRIVERS)('derivation records on %s', (driver) => {
  it('persists the derivation and its verdict by content address', () => {
    const store = withSession(tempDir(), driver);
    try {
      const recorded = record(store, 'PASS');

      expect(recorded).toMatchObject({
        sessionId: SESSION_ID,
        derivationId: DERIVATION_ID,
        status: 'PASS',
        counts: { pass: 1, fail: 0, uncheckable: 0 },
        envLockHash: LOCK,
        title: 'Kinetic energy',
      });
      expect(readDerivation(store, DERIVATION_ID)).toEqual({
        record: recorded,
        derivation: DERIVATION,
        verdict: verdict('PASS'),
      });
      expect(listDerivations(store.db, SESSION_ID)).toEqual([recorded]);
      // Held against collection for as long as the record stands.
      expect(store.blobs.gc().removed).toEqual([]);
      expect(store.blobs.heldBy(derivationBlobRef(DERIVATION_ID))).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it('lets a DERIVED claim rest on a derivation unless a step failed', () => {
    const store = withSession(tempDir(), driver);
    try {
      record(store, 'PASS');
      record(store, 'FAIL', OTHER_DERIVATION);

      store.record([derivedClaim(DERIVATION_ID)]);
      expect(() => store.record([derivedClaim(OTHER_DERIVATION, OTHER_DERIVATION)])).toThrow(
        /LEDGER_FAILED_DERIVATION/,
      );
      // The failed derivation is still history: recorded, listed, newest first.
      expect(listDerivations(store.db, SESSION_ID).map((entry) => entry.status)).toEqual([
        'FAIL',
        'PASS',
      ]);
    } finally {
      store.close();
    }
  });

  it('refuses a second derivation under the same id without touching the first', () => {
    const store = withSession(tempDir(), driver);
    try {
      const first = record(store, 'PASS');

      expect(() => record(store, 'FAIL')).toThrow(/LEDGER_DUPLICATE_DERIVATION/);
      expect(getDerivation(store.db, DERIVATION_ID)).toEqual(first);
      expect(readDerivation(store, DERIVATION_ID)!.verdict.status).toBe('PASS');
    } finally {
      store.close();
    }
  });

  it('rebuilds the derivations table from the log alone', () => {
    const store = withSession(tempDir(), driver);
    try {
      const recorded = record(store, 'UNCHECKABLE');
      store.db.exec('DROP TABLE derivations');
      store.projections.ensure();

      expect(listDerivations(store.db, SESSION_ID)).toEqual([recorded]);
    } finally {
      store.close();
    }
  });
});

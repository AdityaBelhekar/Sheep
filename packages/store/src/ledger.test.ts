import { describe, expect, it } from 'vitest';
import { domainEvent, LedgerError } from '@sheep/core';
import { CLAIM_ID, EXECUTION_ID, SESSION_ID } from '@sheep/core/fixtures';
import { readLedger } from './ledger';
import { openSheepStore } from './store';
import { TESTABLE_DRIVERS, useTempDir } from './test-support';

const tempDir = useTempDir('sheep-ledger-');

const session = domainEvent('session.created', {
  sessionId: SESSION_ID,
  title: 'Sparse attention',
  question: 'Does block-sparse attention preserve perplexity?',
});

const execution = domainEvent('execution.recorded', {
  sessionId: SESSION_ID,
  executionId: EXECUTION_ID,
  codeHash: 'c'.repeat(64),
  exitCode: 0,
});

const empirical = domainEvent('claim.recorded', {
  sessionId: SESSION_ID,
  claimId: CLAIM_ID,
  claimType: 'EMPIRICAL',
  statement: 'Perplexity rises 0.3 nats at 128k context.',
  support: [{ kind: 'EXECUTION', ref: EXECUTION_ID }],
});

describe.each(TESTABLE_DRIVERS)('ledger enforcement on %s', (driver) => {
  it('makes an unbacked empirical claim impossible to record', () => {
    const store = openSheepStore({ dataDir: tempDir(), driver });
    try {
      store.record([session]);
      const before = store.events.count();

      // In one batch with a valid event: the whole batch is refused.
      expect(() =>
        store.record([execution, { ...empirical, payload: { ...empirical.payload, support: [] } }]),
      ).toThrow(LedgerError);
      expect(() => store.record([empirical])).toThrow(/LEDGER_UNKNOWN_EXECUTION/);
      expect(store.events.count()).toBe(before);
      expect(store.events.verify().ok).toBe(true);
    } finally {
      store.close();
    }
  });

  it('records a claim whose execution lands earlier in the same batch', () => {
    const store = openSheepStore({ dataDir: tempDir(), driver });
    try {
      store.record([session, execution, empirical]);
      const ledger = readLedger(store.events, SESSION_ID);
      expect(ledger.claims().map((claim) => claim.claimId)).toEqual([CLAIM_ID]);
      expect(ledger.claim(CLAIM_ID).recordedAt).toMatch(/^\d{4}-/);
      expect(() => store.record([empirical])).toThrow(/LEDGER_DUPLICATE_CLAIM/);
    } finally {
      store.close();
    }
  });
});

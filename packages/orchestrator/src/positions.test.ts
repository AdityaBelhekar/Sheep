import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { domainEvent, Ledger, LedgerError, type DomainEvent, type Position } from '@sheep/core';
import { CLAIM_ID, PARTICIPANT_A, PARTICIPANT_B, ROUND_ID, SESSION_ID } from '@sheep/core/fixtures';
import { commitmentOf, lockPositions } from './positions';

const AT = '2026-09-15T10:00:00.000Z';
const ROUND_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const a: Position = { participantId: PARTICIPANT_A, stance: 'SUPPORT', confidence: 0.7 };
const b: Position = { participantId: PARTICIPANT_B, stance: 'OPPOSE', confidence: 0.6 };

function ledgerWithClaim(): Ledger {
  const ledger = new Ledger(SESSION_ID, { digest });
  ledger.apply(
    domainEvent('claim.recorded', {
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      claimType: 'CONJECTURE',
      statement: 'Sparse attention costs perplexity past 64k tokens.',
    }) as DomainEvent,
    AT,
  );
  return ledger;
}

function applyAll(ledger: Ledger, events: readonly DomainEvent[]): void {
  for (const event of events) ledger.apply(event, AT);
}

function code(run: () => void): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  return undefined;
}

let counter = 0;
const salt = (): string => (counter++).toString(16).padStart(32, '0');

describe('position locking', () => {
  it('commits hashes that reveal nothing, then reveals positions that match them', () => {
    const locked = lockPositions({
      sessionId: SESSION_ID,
      roundId: ROUND_ID,
      claimId: CLAIM_ID,
      positions: [a, b],
    });
    // Nothing about the stance is readable from a commitment.
    expect(JSON.stringify(locked.commits)).not.toMatch(/SUPPORT|OPPOSE|0\.7|0\.6/);

    const ledger = ledgerWithClaim();
    applyAll(ledger, locked.commits);
    applyAll(ledger, locked.reveals);
    expect(ledger.positions().map((reveal) => reveal.position)).toEqual([a, b]);
  });

  it('salts each commitment, so equal positions do not share a hash', () => {
    const same = lockPositions({
      sessionId: SESSION_ID,
      roundId: ROUND_ID,
      claimId: CLAIM_ID,
      positions: [a, { ...a, participantId: PARTICIPANT_B }],
    });
    const [first, second] = same.commits.map(
      (event) => (event.payload as { commitment: string }).commitment,
    );
    expect(first).not.toBe(second);
  });

  it('refuses a reveal that differs from what was committed', () => {
    const locked = lockPositions({
      sessionId: SESSION_ID,
      roundId: ROUND_ID,
      claimId: CLAIM_ID,
      positions: [a],
      salt,
    });
    const ledger = ledgerWithClaim();
    applyAll(ledger, locked.commits);

    const original = locked.reveals[0]!.payload as { salt: string };
    const changedMind = domainEvent('position.revealed', {
      sessionId: SESSION_ID,
      roundId: ROUND_ID,
      claimId: CLAIM_ID,
      position: { ...a, stance: 'OPPOSE' },
      salt: original.salt,
    }) as DomainEvent;
    expect(code(() => ledger.apply(changedMind, AT))).toBe('REVEAL_MISMATCH');

    // A commitment is bound to its round and claim, not just its content.
    expect(commitmentOf(ROUND_2, CLAIM_ID, a, original.salt)).not.toBe(
      commitmentOf(ROUND_ID, CLAIM_ID, a, original.salt),
    );
  });

  it('locks the round once the first position is revealed', () => {
    const early = lockPositions({
      sessionId: SESSION_ID,
      roundId: ROUND_ID,
      claimId: CLAIM_ID,
      positions: [a],
    });
    const late = lockPositions({
      sessionId: SESSION_ID,
      roundId: ROUND_ID,
      claimId: CLAIM_ID,
      positions: [b],
    });
    const ledger = ledgerWithClaim();
    applyAll(ledger, early.commits);
    applyAll(ledger, early.reveals);

    // B saw A's position; B may no longer commit one of its own.
    expect(code(() => applyAll(ledger, late.commits))).toBe('COMMIT_AFTER_REVEAL');
    expect(code(() => applyAll(ledger, late.reveals))).toBe('REVEAL_WITHOUT_COMMITMENT');
    expect(code(() => applyAll(ledger, early.commits))).toBe('DUPLICATE_COMMITMENT');
    expect(code(() => applyAll(ledger, early.reveals))).toBe('DUPLICATE_REVEAL');
  });

  it('refuses a commitment on a claim that does not exist', () => {
    const locked = lockPositions({
      sessionId: SESSION_ID,
      roundId: ROUND_ID,
      claimId: ROUND_2,
      positions: [a],
    });
    expect(code(() => applyAll(ledgerWithClaim(), locked.commits))).toBe('UNKNOWN_CLAIM');
  });
});

describe('movement tracking', () => {
  it('diffs each participant between consecutive sealed reveals', () => {
    const ledger = ledgerWithClaim();
    const round1 = lockPositions({
      sessionId: SESSION_ID,
      roundId: ROUND_ID,
      claimId: CLAIM_ID,
      positions: [a, b],
    });
    const round2 = lockPositions({
      sessionId: SESSION_ID,
      roundId: ROUND_2,
      claimId: CLAIM_ID,
      positions: [
        { ...a, confidence: 0.9 },
        { ...b, stance: 'SUPPORT', confidence: 0.55 },
      ],
    });
    for (const batch of [round1.commits, round1.reveals, round2.commits, round2.reveals]) {
      applyAll(ledger, batch);
    }

    const movements = ledger.movements();
    expect(movements).toHaveLength(2);
    expect(movements[0]).toMatchObject({
      participantId: PARTICIPANT_A,
      fromRoundId: ROUND_ID,
      toRoundId: ROUND_2,
      stanceChanged: false,
    });
    expect(movements[0]?.confidenceDelta).toBeCloseTo(0.2);
    expect(movements[1]).toMatchObject({
      participantId: PARTICIPANT_B,
      stanceChanged: true,
      from: { stance: 'OPPOSE' },
      to: { stance: 'SUPPORT' },
    });
  });
});

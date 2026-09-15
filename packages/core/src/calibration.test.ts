import { describe, expect, it } from 'vitest';
import { calibrationScores, settledOutcome } from './calibration';
import { domainEvent, type DomainEvent, type DomainEventType, type EventPayload } from './events';
import { PARTICIPANT_A, PARTICIPANT_B, ROUND_ID, SESSION_ID } from './fixtures';
import { Ledger } from './ledger';
import type { Position } from './protocol';

const AT = '2026-09-15T10:00:00.000Z';
const HASH = 'f'.repeat(64);
const SALT = '0'.repeat(32);
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const C2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const C3 = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
const D1 = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
const D2 = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';
const D3 = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
const PARTICIPANT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function ev<T extends DomainEventType>(type: T, payload: EventPayload<T>): DomainEvent {
  return domainEvent(type, payload) as DomainEvent;
}

function claim(claimId: string): DomainEvent[] {
  return [
    ev('claim.recorded', {
      sessionId: SESSION_ID,
      claimId,
      claimType: 'CONJECTURE',
      statement: `claim ${claimId}`,
    }),
  ];
}

// No digest on this ledger, so commitments are checked for order, not content.
function positions(claimId: string, ...values: Position[]): DomainEvent[] {
  return [
    ...values.map((value) =>
      ev('position.committed', {
        sessionId: SESSION_ID,
        roundId: ROUND_ID,
        claimId,
        participantId: value.participantId,
        commitment: HASH,
      }),
    ),
    ...values.map((value) =>
      ev('position.revealed', {
        sessionId: SESSION_ID,
        roundId: ROUND_ID,
        claimId,
        position: value,
        salt: SALT,
      }),
    ),
  ];
}

function settle(
  claimId: string,
  disputeId: string,
  outcome: 'UPHELD' | 'OVERTURNED' | 'UNRESOLVED',
): DomainEvent[] {
  return [
    ev('dispute.opened', {
      sessionId: SESSION_ID,
      disputeId,
      claimId,
      axis: 'BASELINES',
      severity: 'major',
      argument: 'Unclear baseline.',
    }),
    ev('dispute.resolved', {
      sessionId: SESSION_ID,
      disputeId,
      outcome,
      rationale: 'Settled by the run.',
      evidence: [{ kind: 'ARTIFACT', ref: HASH }],
      ...(outcome === 'UNRESOLVED'
        ? {
            positions: [
              { participantId: PARTICIPANT_A, stance: 'SUPPORT' as const, confidence: 0.5 },
              { participantId: PARTICIPANT_B, stance: 'OPPOSE' as const, confidence: 0.5 },
            ],
          }
        : {}),
    }),
  ];
}

function ledgerOf(...batches: DomainEvent[][]): Ledger {
  const ledger = new Ledger(SESSION_ID);
  for (const event of batches.flat()) ledger.apply(event, AT);
  return ledger;
}

describe('calibration', () => {
  it('settles outcomes only from decisive resolutions', () => {
    const ledger = ledgerOf(
      claim(C1),
      claim(C2),
      claim(C3),
      settle(C1, D1, 'UPHELD'),
      settle(C2, D2, 'OVERTURNED'),
      settle(C3, D3, 'UNRESOLVED'),
    );
    expect(settledOutcome(ledger, C1)).toBe(1);
    expect(settledOutcome(ledger, C2)).toBe(0);
    expect(settledOutcome(ledger, C3)).toBeNull();
  });

  it('computes Brier scores from sealed positions against settled outcomes', () => {
    const ledger = ledgerOf(
      claim(C1),
      claim(C2),
      claim(C3),
      // A: confident and right twice. B: confident and wrong. C: abstains.
      positions(
        C1,
        { participantId: PARTICIPANT_A, stance: 'SUPPORT', confidence: 0.9 },
        { participantId: PARTICIPANT_B, stance: 'OPPOSE', confidence: 0.7 },
        { participantId: PARTICIPANT_C, stance: 'ABSTAIN', confidence: 0.5 },
      ),
      positions(C2, { participantId: PARTICIPANT_A, stance: 'OPPOSE', confidence: 0.8 }),
      positions(C3, { participantId: PARTICIPANT_A, stance: 'SUPPORT', confidence: 0.1 }),
      settle(C1, D1, 'UPHELD'),
      settle(C2, D2, 'OVERTURNED'),
      settle(C3, D3, 'UNRESOLVED'),
    );

    const scores = calibrationScores(ledger);
    expect(scores.map((score) => score.participantId)).toEqual([
      PARTICIPANT_A,
      PARTICIPANT_B,
      PARTICIPANT_C,
    ]);
    // A: ((0.9 − 1)² + (0.2 − 0)²) / 2; the unresolved C3 is not scored.
    expect(scores[0]?.scored).toBe(2);
    expect(scores[0]?.brier).toBeCloseTo((0.01 + 0.04) / 2);
    // B said the claim holds with probability 0.3; it did.
    expect(scores[1]?.brier).toBeCloseTo(0.49);
    expect(scores[2]).toEqual({ participantId: PARTICIPANT_C, scored: 0, brier: null });
  });

  it('scores nothing while no dispute has settled', () => {
    const ledger = ledgerOf(
      claim(C1),
      positions(C1, { participantId: PARTICIPANT_A, stance: 'SUPPORT', confidence: 0.9 }),
    );
    expect(calibrationScores(ledger)).toEqual([
      { participantId: PARTICIPANT_A, scored: 0, brier: null },
    ]);
  });
});

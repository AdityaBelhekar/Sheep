import { describe, expect, it } from 'vitest';
import { domainEvent, type DomainEvent, type DomainEventType, type EventPayload } from './events';
import { CLAIM_ID, DISPUTE_ID, PARTICIPANT_A, PARTICIPANT_B, SESSION_ID } from './fixtures';
import { Ledger, LedgerError, type LedgerErrorCode } from './ledger';

const AT = '2026-09-15T10:00:00.000Z';
const LATER = '2026-09-15T11:00:00.000Z';
const OTHER_SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DISPUTE_2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const HASH = 'f'.repeat(64);

function ev<T extends DomainEventType>(type: T, payload: EventPayload<T>): DomainEvent {
  return domainEvent(type, payload) as DomainEvent;
}

const conjecture = (claimId = CLAIM_ID): DomainEvent =>
  ev('claim.recorded', {
    sessionId: SESSION_ID,
    claimId,
    claimType: 'CONJECTURE',
    statement: 'Sparse attention costs perplexity past 64k tokens.',
  });

const openDispute = (disputeId = DISPUTE_ID, claimId = CLAIM_ID): DomainEvent =>
  ev('dispute.opened', {
    sessionId: SESSION_ID,
    disputeId,
    claimId,
    axis: 'BASELINES',
    severity: 'major',
    argument: 'No dense baseline.',
    raisedByParticipantId: PARTICIPANT_B,
  });

const status = (value: 'asserted' | 'supported' | 'withdrawn' | 'disputed'): DomainEvent =>
  ev('claim.status-changed', { sessionId: SESSION_ID, claimId: CLAIM_ID, status: value });

function ledgerOf(...events: DomainEvent[]): Ledger {
  const ledger = new Ledger(SESSION_ID);
  for (const event of events) ledger.apply(event, AT);
  return ledger;
}

function rejects(ledger: Ledger, event: DomainEvent, code: LedgerErrorCode): void {
  const before = JSON.stringify([ledger.claims(), ledger.disputes(), ledger.resolutions()]);
  let caught: unknown;
  try {
    ledger.apply(event, LATER);
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(LedgerError);
  expect((caught as LedgerError).code).toBe(code);
  expect((caught as LedgerError).message).toMatch(new RegExp(`^LEDGER_${code}: `));
  // A refused event changes nothing — this is what lets a writer check first.
  expect(JSON.stringify([ledger.claims(), ledger.disputes(), ledger.resolutions()])).toBe(before);
}

describe('claims', () => {
  it('records a claim as asserted, with the time it was recorded', () => {
    const claim = ledgerOf(conjecture()).claim(CLAIM_ID);
    expect(claim).toMatchObject({
      claimId: CLAIM_ID,
      claimType: 'CONJECTURE',
      status: 'asserted',
      phaseId: null,
      messageId: null,
      support: [],
      recordedAt: AT,
      updatedAt: AT,
    });
  });

  it('refuses a second claim with the same id', () => {
    rejects(ledgerOf(conjecture()), conjecture(), 'DUPLICATE_CLAIM');
  });

  it('refuses anything about a claim it has never seen', () => {
    rejects(ledgerOf(), status('supported'), 'UNKNOWN_CLAIM');
    rejects(ledgerOf(), openDispute(), 'UNKNOWN_CLAIM');
  });

  it('refuses events that belong to another session', () => {
    rejects(
      ledgerOf(),
      ev('claim.recorded', {
        sessionId: OTHER_SESSION,
        claimId: CLAIM_ID,
        claimType: 'CONJECTURE',
        statement: 'x',
      }),
      'CROSS_SESSION',
    );
  });

  it('lets only a dispute say a claim is disputed, refuted or unresolved', () => {
    rejects(ledgerOf(conjecture()), status('disputed'), 'STATUS_NEEDS_DISPUTE');
  });

  it('closes a withdrawn claim to further change', () => {
    const ledger = ledgerOf(conjecture(), status('withdrawn'));
    expect(ledger.claim(CLAIM_ID).status).toBe('withdrawn');
    rejects(ledger, status('asserted'), 'CLAIM_CLOSED');
    rejects(ledger, openDispute(), 'CLAIM_CLOSED');
  });

  it('ignores events that are not about the ledger', () => {
    const ledger = ledgerOf();
    ledger.apply(ev('session.retitled', { sessionId: SESSION_ID, title: 'x' }), AT);
    expect(ledger.claims()).toEqual([]);
  });
});

describe('disputes', () => {
  it('marks the claim disputed while a dispute is open', () => {
    const ledger = ledgerOf(conjecture(), openDispute());
    expect(ledger.claim(CLAIM_ID).status).toBe('disputed');
    expect(ledger.disputesOf(CLAIM_ID)).toHaveLength(1);
    rejects(ledger, status('supported'), 'OPEN_DISPUTES');
    rejects(ledger, openDispute(), 'DUPLICATE_DISPUTE');
  });

  it('refuses to settle a dispute on rationale alone', () => {
    const ledger = ledgerOf(conjecture(), openDispute());
    for (const evidence of [[], [{ kind: 'ARGUMENT' as const, ref: 'the referee said so' }]]) {
      rejects(
        ledger,
        ev('dispute.resolved', {
          sessionId: SESSION_ID,
          disputeId: DISPUTE_ID,
          outcome: 'OVERTURNED',
          rationale: 'Unconvincing.',
          evidence,
        }),
        'RESOLUTION_WITHOUT_EVIDENCE',
      );
    }
  });

  it('returns an upheld claim to the status it had before', () => {
    const ledger = ledgerOf(
      conjecture(),
      openDispute(),
      ev('dispute.resolved', {
        sessionId: SESSION_ID,
        disputeId: DISPUTE_ID,
        outcome: 'UPHELD',
        rationale: 'The baseline was run.',
        evidence: [{ kind: 'ARTIFACT', ref: HASH }],
      }),
    );
    expect(ledger.claim(CLAIM_ID).status).toBe('asserted');
    expect(ledger.disputes()[0]?.status).toBe('resolved');
    expect(ledger.resolutions()[0]?.outcome).toBe('UPHELD');
  });

  it('refutes an overturned claim and closes it', () => {
    const ledger = ledgerOf(
      conjecture(),
      openDispute(),
      ev('dispute.resolved', {
        sessionId: SESSION_ID,
        disputeId: DISPUTE_ID,
        outcome: 'OVERTURNED',
        rationale: 'The dense baseline matches.',
        evidence: [{ kind: 'ARTIFACT', ref: HASH }],
      }),
    );
    expect(ledger.claim(CLAIM_ID).status).toBe('refuted');
    rejects(ledger, openDispute(DISPUTE_2), 'CLAIM_CLOSED');
  });

  it('keeps both sides of an unresolved dispute, or refuses it', () => {
    const base = {
      sessionId: SESSION_ID,
      disputeId: DISPUTE_ID,
      outcome: 'UNRESOLVED' as const,
      rationale: 'Nothing discriminates.',
      evidence: [],
    };
    const ledger = ledgerOf(conjecture(), openDispute());
    rejects(
      ledger,
      ev('dispute.resolved', {
        ...base,
        positions: [{ participantId: PARTICIPANT_A, stance: 'SUPPORT', confidence: 0.6 }],
      }),
      'UNRESOLVED_WITHOUT_POSITIONS',
    );

    ledger.apply(
      ev('dispute.resolved', {
        ...base,
        positions: [
          { participantId: PARTICIPANT_A, stance: 'SUPPORT', confidence: 0.6 },
          { participantId: PARTICIPANT_B, stance: 'OPPOSE', confidence: 0.7 },
        ],
      }),
      LATER,
    );
    expect(ledger.claim(CLAIM_ID)).toMatchObject({ status: 'unresolved', updatedAt: LATER });
    expect(ledger.resolutions()[0]?.positions).toHaveLength(2);
  });

  it('lets a dispute close only once', () => {
    const ledger = ledgerOf(
      conjecture(),
      openDispute(),
      ev('dispute.withdrawn', { sessionId: SESSION_ID, disputeId: DISPUTE_ID }),
    );
    expect(ledger.claim(CLAIM_ID).status).toBe('asserted');
    rejects(
      ledger,
      ev('dispute.withdrawn', { sessionId: SESSION_ID, disputeId: DISPUTE_ID }),
      'DISPUTE_CLOSED',
    );
    rejects(
      ledger,
      ev('dispute.withdrawn', { sessionId: SESSION_ID, disputeId: DISPUTE_2 }),
      'UNKNOWN_DISPUTE',
    );
  });

  it('ranks an open dispute above an earlier unresolved one', () => {
    const ledger = ledgerOf(
      conjecture(),
      openDispute(),
      ev('dispute.resolved', {
        sessionId: SESSION_ID,
        disputeId: DISPUTE_ID,
        outcome: 'UNRESOLVED',
        rationale: 'Nothing discriminates.',
        evidence: [],
        positions: [
          { participantId: PARTICIPANT_A, stance: 'SUPPORT', confidence: 0.6 },
          { participantId: PARTICIPANT_B, stance: 'OPPOSE', confidence: 0.7 },
        ],
      }),
      openDispute(DISPUTE_2),
    );
    expect(ledger.claim(CLAIM_ID).status).toBe('disputed');
  });
});

describe('replay', () => {
  it('skips and reports entries that break a rule instead of failing the session', () => {
    const ledger = Ledger.replay(SESSION_ID, [
      { event: conjecture(), recordedAt: AT },
      { event: status('disputed'), recordedAt: AT },
      { event: openDispute(), recordedAt: LATER },
    ]);
    expect(ledger.claim(CLAIM_ID).status).toBe('disputed');
    expect(ledger.rejected.map((entry) => entry.error.code)).toEqual(['STATUS_NEEDS_DISPUTE']);
  });
});

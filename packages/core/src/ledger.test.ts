import { describe, expect, it } from 'vitest';
import { domainEvent, type DomainEvent, type DomainEventType, type EventPayload } from './events';
import {
  CLAIM_ID,
  DERIVATION_ID,
  DISPUTE_ID,
  EXECUTION_ID,
  PARTICIPANT_A,
  PARTICIPANT_B,
  SESSION_ID,
  CHECKED_DERIVATION,
  CLEAN_RUN,
} from './fixtures';
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

const executed = (exitCode = 0, executionId = EXECUTION_ID): DomainEvent =>
  ev('execution.recorded', {
    sessionId: SESSION_ID,
    executionId,
    ...CLEAN_RUN,
    exitCode,
    status: exitCode === 0 ? 'ok' : 'error',
  });

const derived = (
  verdict: Partial<Pick<typeof CHECKED_DERIVATION, 'status' | 'counts'>> = {},
): DomainEvent =>
  ev('derivation.recorded', {
    sessionId: SESSION_ID,
    derivationId: DERIVATION_ID,
    ...CHECKED_DERIVATION,
    ...verdict,
  });

type Support = EventPayload<'claim.recorded'>['support'];

const claimOf = (
  claimType: 'EMPIRICAL' | 'DERIVED' | 'CITED' | 'CONJECTURE',
  support: Support = [],
  claimId = CLAIM_ID,
): DomainEvent =>
  ev('claim.recorded', {
    sessionId: SESSION_ID,
    claimId,
    claimType,
    statement: 'Perplexity rises 0.3 nats at 128k context.',
    support,
  });

const empiricalClaim = (claimId = CLAIM_ID): DomainEvent =>
  claimOf('EMPIRICAL', [{ kind: 'EXECUTION', ref: EXECUTION_ID }], claimId);

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
    rejects(ledger, openDispute(), 'DUPLICATE_DISPUTE');

    const empirical = ledgerOf(executed(), empiricalClaim(), openDispute());
    rejects(empirical, status('supported'), 'OPEN_DISPUTES');
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

describe('claim type enforcement (P2)', () => {
  it('refuses an EMPIRICAL claim with no execution behind it', () => {
    rejects(ledgerOf(), claimOf('EMPIRICAL'), 'EMPIRICAL_WITHOUT_EXECUTION');
    // Prose and citations are not an execution, however many there are.
    rejects(
      ledgerOf(),
      claimOf('EMPIRICAL', [
        { kind: 'ARGUMENT', ref: 'obviously true' },
        { kind: 'CITATION', ref: 'arXiv:2401.00001' },
      ]),
      'EMPIRICAL_WITHOUT_EXECUTION',
    );
  });

  it('refuses an EMPIRICAL claim pointing at a run that never happened, or failed', () => {
    rejects(ledgerOf(), empiricalClaim(), 'UNKNOWN_EXECUTION');
    rejects(ledgerOf(executed(1)), empiricalClaim(), 'FAILED_EXECUTION');
  });

  it('records an EMPIRICAL claim backed by a clean execution', () => {
    expect(ledgerOf(executed(), empiricalClaim()).claim(CLAIM_ID).claimType).toBe('EMPIRICAL');
  });

  it('refuses a DERIVED claim without a recorded derivation', () => {
    rejects(ledgerOf(), claimOf('DERIVED'), 'DERIVED_WITHOUT_DERIVATION');
    rejects(
      ledgerOf(),
      claimOf('DERIVED', [{ kind: 'DERIVATION', ref: DERIVATION_ID }]),
      'UNKNOWN_DERIVATION',
    );
    const ledger = ledgerOf(
      derived(),
      claimOf('DERIVED', [{ kind: 'DERIVATION', ref: DERIVATION_ID }]),
    );
    expect(ledger.claim(CLAIM_ID).status).toBe('asserted');
  });

  it('refuses a CITED claim with no citation', () => {
    rejects(ledgerOf(), claimOf('CITED'), 'CITED_WITHOUT_CITATION');
  });

  it('lets CITED and CONJECTURE claims support, but never be established alone', () => {
    const cited = ledgerOf(claimOf('CITED', [{ kind: 'CITATION', ref: 'doi:10.1000/x' }]));
    rejects(cited, status('supported'), 'CANNOT_ESTABLISH_ALONE');
    rejects(ledgerOf(conjecture()), status('supported'), 'CANNOT_ESTABLISH_ALONE');

    const established = ledgerOf(executed(), empiricalClaim());
    established.apply(status('supported'), LATER);
    expect(established.claim(CLAIM_ID).status).toBe('supported');
  });

  it('refuses to establish a conclusion on citations alone, however they are chained', () => {
    const CITED_ID = DISPUTE_2;
    const ledger = ledgerOf(
      claimOf('CITED', [{ kind: 'CITATION', ref: 'doi:10.1000/x' }], CITED_ID),
    );
    rejects(
      ledger,
      claimOf('EMPIRICAL', [{ kind: 'CLAIM', ref: CITED_ID }]),
      'EMPIRICAL_WITHOUT_EXECUTION',
    );
  });

  it('checks evidence attached later exactly as strictly', () => {
    const ledger = ledgerOf(conjecture());
    rejects(
      ledger,
      ev('claim.evidence-attached', {
        sessionId: SESSION_ID,
        claimId: CLAIM_ID,
        evidence: { kind: 'EXECUTION', ref: EXECUTION_ID },
      }),
      'UNKNOWN_EXECUTION',
    );
  });

  it('keeps claim support acyclic and resting only on claims that still stand', () => {
    const B = DISPUTE_2;
    const ledger = ledgerOf(
      conjecture(),
      claimOf('CONJECTURE', [{ kind: 'CLAIM', ref: CLAIM_ID }], B),
    );
    const attach = (claimId: string, ref: string): DomainEvent =>
      ev('claim.evidence-attached', {
        sessionId: SESSION_ID,
        claimId,
        evidence: { kind: 'CLAIM', ref },
      });

    rejects(ledger, attach(CLAIM_ID, CLAIM_ID), 'CYCLIC_SUPPORT');
    rejects(ledger, attach(CLAIM_ID, B), 'CYCLIC_SUPPORT');
    rejects(ledger, attach(B, OTHER_SESSION), 'UNKNOWN_SUPPORTING_CLAIM');

    ledger.apply(status('withdrawn'), LATER);
    rejects(
      ledger,
      claimOf('CONJECTURE', [{ kind: 'CLAIM', ref: CLAIM_ID }], OTHER_SESSION),
      'SUPPORT_NOT_STANDING',
    );
  });

  it('checks the evidence a resolution cites', () => {
    rejects(
      ledgerOf(conjecture(), openDispute()),
      ev('dispute.resolved', {
        sessionId: SESSION_ID,
        disputeId: DISPUTE_ID,
        outcome: 'OVERTURNED',
        rationale: 'The run says otherwise.',
        evidence: [{ kind: 'EXECUTION', ref: EXECUTION_ID }],
      }),
      'UNKNOWN_EXECUTION',
    );
  });

  it('refuses an execution whose status and exit code disagree', () => {
    const disagreeing = (status: 'ok' | 'timeout', exitCode: number): DomainEvent =>
      ev('execution.recorded', {
        sessionId: SESSION_ID,
        executionId: EXECUTION_ID,
        ...CLEAN_RUN,
        status,
        exitCode,
      });

    // Either would let a run that did not finish cleanly back a claim.
    rejects(ledgerOf(), disagreeing('timeout', 0), 'INCONSISTENT_EXECUTION');
    rejects(ledgerOf(), disagreeing('ok', 1), 'INCONSISTENT_EXECUTION');
  });

  it('refuses a DERIVED claim resting on a derivation with a failed step', () => {
    const cite = claimOf('DERIVED', [{ kind: 'DERIVATION', ref: DERIVATION_ID }]);
    const failed = { status: 'FAIL', counts: { pass: 2, fail: 1, uncheckable: 0 } } as const;
    const undecided = {
      status: 'UNCHECKABLE',
      counts: { pass: 2, fail: 0, uncheckable: 1 },
    } as const;

    rejects(ledgerOf(derived(failed)), cite, 'FAILED_DERIVATION');
    // Undecided is not failed. It may be cited, and is labelled wherever it is shown.
    expect(ledgerOf(derived(undecided), cite).claim(CLAIM_ID).claimType).toBe('DERIVED');
    // A record cannot call itself a pass while counting a failed step.
    rejects(
      ledgerOf(),
      derived({ status: 'PASS', counts: { pass: 2, fail: 1, uncheckable: 0 } }),
      'INCONSISTENT_DERIVATION',
    );
  });

  it('refuses to record the same execution or derivation twice', () => {
    rejects(ledgerOf(executed()), executed(), 'DUPLICATE_EXECUTION');
    rejects(ledgerOf(derived()), derived(), 'DUPLICATE_DERIVATION');
  });
});

describe('ancestry', () => {
  it('lists every supporting claim transitively, nearest first, each once', () => {
    const B = DISPUTE_2;
    const C = OTHER_SESSION;
    const ledger = ledgerOf(
      conjecture(),
      claimOf('CONJECTURE', [{ kind: 'CLAIM', ref: CLAIM_ID }], B),
      // C rests on A directly and through B: A is listed once, at depth 1.
      claimOf(
        'CONJECTURE',
        [
          { kind: 'CLAIM', ref: B },
          { kind: 'CLAIM', ref: CLAIM_ID },
        ],
        C,
      ),
    );
    expect(ledger.ancestry(C).map((entry) => [entry.claim.claimId, entry.depth])).toEqual([
      [B, 1],
      [CLAIM_ID, 1],
    ]);
    const chain = ledgerOf(
      conjecture(),
      claimOf('CONJECTURE', [{ kind: 'CLAIM', ref: CLAIM_ID }], B),
      claimOf('CONJECTURE', [{ kind: 'CLAIM', ref: B }], C),
    );
    expect(chain.ancestry(C).map((entry) => [entry.claim.claimId, entry.depth])).toEqual([
      [B, 1],
      [CLAIM_ID, 2],
    ]);
    expect(chain.ancestry(CLAIM_ID)).toEqual([]);
  });
});

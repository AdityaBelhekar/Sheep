import { describe, expect, it } from 'vitest';
import { domainEvent, type DomainEvent } from '@sheep/core';
import {
  assertCanClosePhase,
  assertCanOpenPhase,
  assertCanOpenRound,
  assertCanResolveGate,
  nextPhaseKind,
  openPhase,
  pendingGate,
  ProtocolError,
  reduceProtocol,
} from './state';

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '99999999-9999-4999-8999-999999999999';
const PHASE = '22222222-2222-4222-8222-222222222222';
const ROUND = '33333333-3333-4333-8333-333333333333';
const ALICE = '44444444-4444-4444-8444-444444444444';
const BOB = '55555555-5555-4555-8555-555555555555';
const OPTION = '66666666-6666-4666-8666-666666666666';

function framingOpened(): DomainEvent[] {
  return [
    domainEvent('phase.opened', { sessionId: SESSION, phaseId: PHASE, kind: 'FRAMING', index: 0 }),
    domainEvent('round.opened', {
      sessionId: SESSION,
      phaseId: PHASE,
      roundId: ROUND,
      index: 0,
      mode: 'BLIND_PARALLEL',
    }),
    domainEvent('roster.roles-assigned', {
      sessionId: SESSION,
      phaseId: PHASE,
      roundId: ROUND,
      assignments: [
        { participantId: ALICE, role: 'PROPOSER' },
        { participantId: BOB, role: 'PROPOSER' },
      ],
    }),
  ];
}

describe('reduceProtocol', () => {
  it('starts a session in draft with no phases', () => {
    const state = reduceProtocol(SESSION, []);
    expect(state.status).toBe('draft');
    expect(state.phases).toEqual([]);
    expect(nextPhaseKind(state)).toBe('FRAMING');
  });

  it('opening a phase starts the session running', () => {
    const state = reduceProtocol(SESSION, framingOpened());
    expect(state.status).toBe('running');
    expect(openPhase(state)?.kind).toBe('FRAMING');
    expect(state.phases[0]?.rounds[0]?.mode).toBe('BLIND_PARALLEL');
  });

  it('ignores events from another session', () => {
    const state = reduceProtocol(OTHER_SESSION, framingOpened());
    expect(state.phases).toEqual([]);
    expect(state.status).toBe('draft');
  });

  it('records who spoke, and the prompt hashes already answered', () => {
    const promptHash = 'a'.repeat(64);
    const state = reduceProtocol(SESSION, [
      ...framingOpened(),
      domainEvent('message.recorded', {
        sessionId: SESSION,
        messageId: '77777777-7777-4777-8777-777777777777',
        phaseId: PHASE,
        roundId: ROUND,
        author: {
          kind: 'MODEL',
          participantId: ALICE,
          model: {
            connectionId: '88888888-8888-4888-8888-888888888888',
            vendorId: 'anthropic',
            modelId: 'claude-opus-5',
          },
        },
        role: 'PROPOSER',
        body: { kind: 'text', text: 'a framing' },
        finish: 'stop',
        promptHash,
      }),
    ]);
    expect(state.phases[0]?.rounds[0]?.spoke).toEqual([ALICE]);
    expect(state.answeredPromptHashes.has(promptHash)).toBe(true);
  });

  it('tallies role history for rotation', () => {
    const state = reduceProtocol(SESSION, framingOpened());
    expect(state.roleHistory[ALICE]).toEqual({ PROPOSER: 1 });
  });

  it('a raised gate parks the phase and is discoverable', () => {
    const state = reduceProtocol(SESSION, [
      ...framingOpened(),
      domainEvent('round.closed', {
        sessionId: SESSION,
        phaseId: PHASE,
        roundId: ROUND,
        outcome: 'complete',
      }),
      domainEvent('phase.gate-raised', {
        sessionId: SESSION,
        phaseId: PHASE,
        gate: 'charter',
        proposal: 'QUESTION — does it hold at 128k?',
        options: [{ optionId: OPTION, label: 'Charter v1' }],
      }),
    ]);
    expect(state.phases[0]?.status).toBe('awaiting-approval');
    expect(pendingGate(state)?.gate.proposal).toContain('128k');
  });

  it('resolving a gate hands control back without closing the phase', () => {
    const state = reduceProtocol(SESSION, [
      ...framingOpened(),
      domainEvent('round.closed', {
        sessionId: SESSION,
        phaseId: PHASE,
        roundId: ROUND,
        outcome: 'complete',
      }),
      domainEvent('phase.gate-raised', {
        sessionId: SESSION,
        phaseId: PHASE,
        gate: 'charter',
        proposal: 'a charter',
      }),
      domainEvent('phase.gate-resolved', {
        sessionId: SESSION,
        phaseId: PHASE,
        gate: 'charter',
        decision: 'approved',
      }),
    ]);
    expect(state.phases[0]?.status).toBe('running');
    expect(state.phases[0]?.gate?.decision).toBe('approved');
    expect(pendingGate(state)).toBeNull();
  });

  it('replays identically however the events are chunked', () => {
    const events = [
      ...framingOpened(),
      domainEvent('round.closed', {
        sessionId: SESSION,
        phaseId: PHASE,
        roundId: ROUND,
        outcome: 'complete',
      }),
      domainEvent('phase.closed', {
        sessionId: SESSION,
        phaseId: PHASE,
        outcome: 'complete',
        summary: 'charter approved',
      }),
    ];
    const whole = reduceProtocol(SESSION, events);
    const halves = reduceProtocol(SESSION, [...events.slice(0, 2), ...events.slice(2)]);
    expect(JSON.stringify(toComparable(whole))).toBe(JSON.stringify(toComparable(halves)));
    expect(nextPhaseKind(whole)).toBe('HYPOTHESIS');
  });
});

describe('guards', () => {
  const running = reduceProtocol(SESSION, framingOpened());

  it('refuses to open a phase while another is running', () => {
    expect(() => {
      assertCanOpenPhase(running, 'HYPOTHESIS');
    }).toThrow(ProtocolError);
  });

  it('refuses to open a phase out of sequence', () => {
    const fresh = reduceProtocol(SESSION, []);
    expect(() => {
      assertCanOpenPhase(fresh, 'METHOD');
    }).toThrow(/the next phase is FRAMING/);
  });

  it('refuses a second open round in the same phase', () => {
    expect(() => {
      assertCanOpenRound(running, PHASE);
    }).toThrow(/is still open/);
  });

  it('refuses to close a phase with an open round', () => {
    expect(() => {
      assertCanClosePhase(running, PHASE);
    }).toThrow(/is still open/);
  });

  it('refuses to resolve a gate that was never raised', () => {
    expect(() => {
      assertCanResolveGate(running, PHASE, 'charter');
    }).toThrow(/no charter gate open/);
  });

  it('a failed phase stops the sequence rather than being skipped past', () => {
    const failed = reduceProtocol(SESSION, [
      ...framingOpened(),
      domainEvent('round.closed', {
        sessionId: SESSION,
        phaseId: PHASE,
        roundId: ROUND,
        outcome: 'aborted',
      }),
      domainEvent('phase.closed', {
        sessionId: SESSION,
        phaseId: PHASE,
        outcome: 'failed',
        summary: 'every model failed',
      }),
    ]);
    expect(nextPhaseKind(failed)).toBeNull();
  });
});

/** Maps are not JSON-comparable; this is only for the replay-equality check. */
function toComparable(state: ReturnType<typeof reduceProtocol>): unknown {
  return {
    ...state,
    answeredPromptHashes: [...state.answeredPromptHashes],
    phases: state.phases.map((phase) => ({
      ...phase,
      rounds: phase.rounds.map((round) => ({ ...round, assignments: [...round.assignments] })),
    })),
  };
}

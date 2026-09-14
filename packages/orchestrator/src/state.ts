import {
  PHASE_KINDS,
  type DomainEvent,
  type GateDecision,
  type GateKind,
  type GateOption,
  type ParticipantRole,
  type PhaseKind,
  type PhaseStatus,
  type RoundMode,
  type RoundStatus,
  type SessionStatus,
} from '@sheep/core';

/**
 * Where a session is in the protocol — folded out of the event log, never
 * stored.
 *
 * This is the one design decision the rest of Stage 4 rests on. A protocol
 * state machine normally keeps its own table and writes transitions into it;
 * this one *is* a replay of the events, so three things the roadmap asks for
 * separately fall out of the same code:
 *
 * - **Every transition is an event** (Phase 23) — because there is nowhere
 *   else a transition could be recorded.
 * - **Resume is free** (Phase 29) — reopening the app rebuilds this from the
 *   log and carries on; there is no checkpoint that could disagree with it.
 * - **Replay is exact** (P5) — the same events always produce the same state.
 *
 * The price is that the machine cannot hold anything the log does not, which is
 * the correct constraint rather than a limitation.
 */

/** The seven phases, in the order a session moves through them. */
export const PHASE_SEQUENCE: readonly PhaseKind[] = PHASE_KINDS;

export interface RoundState {
  readonly roundId: string;
  readonly phaseId: string;
  readonly index: number;
  readonly mode: RoundMode;
  readonly status: RoundStatus;
  readonly assignments: ReadonlyMap<string, ParticipantRole>;
  /** Participants that produced a turn in this round, in arrival order. */
  readonly spoke: readonly string[];
}

export interface GateState {
  readonly gate: GateKind;
  readonly proposal: string;
  readonly options: readonly GateOption[];
  readonly decision: GateDecision | null;
  readonly selected: readonly string[];
  readonly note: string | null;
}

export interface PhaseState {
  readonly phaseId: string;
  readonly kind: PhaseKind;
  readonly index: number;
  readonly status: PhaseStatus;
  readonly rounds: readonly RoundState[];
  /** The most recent gate raised in this phase, resolved or not. */
  readonly gate: GateState | null;
  readonly summary: string | null;
}

export type RoleTally = Readonly<Partial<Record<ParticipantRole, number>>>;

export interface ProtocolState {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly phases: readonly PhaseState[];
  /** Prompt hashes already answered, so a retry never pays for a turn twice. */
  readonly answeredPromptHashes: ReadonlySet<string>;
  /** Per-participant tally of roles held; what rotation is scored against. */
  readonly roleHistory: Readonly<Record<string, RoleTally>>;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function initialProtocolState(sessionId: string): ProtocolState {
  return {
    sessionId,
    status: 'draft',
    phases: [],
    answeredPromptHashes: new Set(),
    roleHistory: {},
  };
}

const PROTOCOL_EVENT_TYPES = new Set<string>([
  'session.status-changed',
  'phase.opened',
  'phase.closed',
  'phase.gate-raised',
  'phase.gate-resolved',
  'round.opened',
  'round.closed',
  'roster.roles-assigned',
  'message.recorded',
]);

export function isProtocolEvent(type: string): boolean {
  return PROTOCOL_EVENT_TYPES.has(type);
}

/**
 * Folds one event into the state.
 *
 * Events for another session, and events the protocol does not care about, pass
 * through unchanged — so a replay can hand this the whole log and stay simple.
 */
export function applyProtocolEvent(state: ProtocolState, event: DomainEvent): ProtocolState {
  if (!isProtocolEvent(event.type)) return state;
  const scope = event.payload as { sessionId?: string };
  if (scope.sessionId !== state.sessionId) return state;

  switch (event.type) {
    case 'session.status-changed':
      return { ...state, status: event.payload.status };

    case 'phase.opened': {
      const { phaseId, kind, index } = event.payload;
      if (state.phases.some((phase) => phase.phaseId === phaseId)) return state;
      return {
        ...state,
        status: state.status === 'draft' ? 'running' : state.status,
        phases: [
          ...state.phases,
          { phaseId, kind, index, status: 'running', rounds: [], gate: null, summary: null },
        ],
      };
    }

    case 'phase.closed': {
      const { phaseId, outcome, summary } = event.payload;
      return mapPhase(state, phaseId, (phase) => ({
        ...phase,
        status: outcome,
        summary: summary ?? phase.summary,
      }));
    }

    case 'phase.gate-raised': {
      const { phaseId, gate, proposal, options } = event.payload;
      return mapPhase(state, phaseId, (phase) => ({
        ...phase,
        status: 'awaiting-approval',
        gate: { gate, proposal, options: options ?? [], decision: null, selected: [], note: null },
      }));
    }

    case 'phase.gate-resolved': {
      const { phaseId, gate, decision, selected, note } = event.payload;
      return mapPhase(state, phaseId, (phase) =>
        phase.gate === null || phase.gate.gate !== gate
          ? phase
          : {
              ...phase,
              // Resolving the gate hands control back to the runner. The phase
              // is closed by its own `phase.closed`, not by the approval — a
              // rejected charter is redrafted inside the same phase.
              status: 'running',
              gate: { ...phase.gate, decision, selected: selected ?? [], note: note ?? null },
            },
      );
    }

    case 'round.opened': {
      const { phaseId, roundId, index, mode } = event.payload;
      return mapPhase(state, phaseId, (phase) =>
        phase.rounds.some((round) => round.roundId === roundId)
          ? phase
          : {
              ...phase,
              rounds: [
                ...phase.rounds,
                {
                  roundId,
                  phaseId,
                  index,
                  mode,
                  status: 'open' as RoundStatus,
                  assignments: new Map<string, ParticipantRole>(),
                  spoke: [],
                },
              ],
            },
      );
    }

    case 'round.closed': {
      const { phaseId, roundId, outcome } = event.payload;
      return mapRound(state, phaseId, roundId, (round) => ({ ...round, status: outcome }));
    }

    case 'roster.roles-assigned': {
      const { phaseId, roundId, assignments } = event.payload;
      const history: Record<string, RoleTally> = { ...state.roleHistory };
      for (const assignment of assignments) {
        const tally: Partial<Record<ParticipantRole, number>> = {
          ...(history[assignment.participantId] ?? {}),
        };
        tally[assignment.role] = (tally[assignment.role] ?? 0) + 1;
        history[assignment.participantId] = tally;
      }
      const next = mapRound(state, phaseId, roundId, (round) => ({
        ...round,
        assignments: new Map(assignments.map((entry) => [entry.participantId, entry.role])),
      }));
      return { ...next, roleHistory: history };
    }

    case 'message.recorded': {
      const { phaseId, roundId, author, promptHash } = event.payload;
      const answered =
        promptHash === undefined
          ? state.answeredPromptHashes
          : new Set([...state.answeredPromptHashes, promptHash]);

      const withSpoke =
        phaseId === undefined || roundId === undefined || author.kind !== 'MODEL'
          ? state
          : mapRound(state, phaseId, roundId, (round) =>
              round.spoke.includes(author.participantId)
                ? round
                : { ...round, spoke: [...round.spoke, author.participantId] },
            );
      return { ...withSpoke, answeredPromptHashes: answered };
    }

    default:
      return state;
  }
}

/** Rebuilds state from a session's events. This is what resume is. */
export function reduceProtocol(sessionId: string, events: Iterable<DomainEvent>): ProtocolState {
  let state = initialProtocolState(sessionId);
  for (const event of events) state = applyProtocolEvent(state, event);
  return state;
}

// ---------------------------------------------------------------------------
// Queries and guards
// ---------------------------------------------------------------------------

export function phaseById(state: ProtocolState, phaseId: string): PhaseState {
  const phase = state.phases.find((candidate) => candidate.phaseId === phaseId);
  if (!phase) throw new ProtocolError(`unknown phase: ${phaseId}`);
  return phase;
}

/** The phase currently running or waiting on a human, if there is one. */
export function openPhase(state: ProtocolState): PhaseState | undefined {
  return state.phases.find(
    (phase) => phase.status === 'running' || phase.status === 'awaiting-approval',
  );
}

/** A gate that has been raised and not yet answered. */
export function pendingGate(state: ProtocolState): { phase: PhaseState; gate: GateState } | null {
  for (const phase of state.phases) {
    if (phase.gate && phase.gate.decision === null) return { phase, gate: phase.gate };
  }
  return null;
}

/**
 * The next phase to open, or null when there is none.
 *
 * A failed phase stops the sequence rather than being skipped past: the phases
 * build on each other, and running METHOD against a charter that never
 * completed would produce a protocol nobody agreed to.
 */
export function nextPhaseKind(state: ProtocolState): PhaseKind | null {
  for (const kind of PHASE_SEQUENCE) {
    const existing = state.phases.find((phase) => phase.kind === kind);
    if (!existing) return kind;
    if (existing.status !== 'complete' && existing.status !== 'skipped') return null;
  }
  return null;
}

export function assertCanOpenPhase(state: ProtocolState, kind: PhaseKind): void {
  const running = openPhase(state);
  if (running) {
    throw new ProtocolError(`cannot open ${kind}: ${running.kind} is still ${running.status}`);
  }
  if (state.phases.some((phase) => phase.kind === kind)) {
    throw new ProtocolError(`cannot open ${kind}: it has already run`);
  }
  const expected = nextPhaseKind(state);
  if (expected !== kind) {
    throw new ProtocolError(
      `cannot open ${kind}: the next phase is ${expected ?? 'none — the session is finished'}`,
    );
  }
}

export function assertCanOpenRound(state: ProtocolState, phaseId: string): void {
  const phase = phaseById(state, phaseId);
  if (phase.status !== 'running') {
    throw new ProtocolError(`cannot open a round: ${phase.kind} is ${phase.status}`);
  }
  const unfinished = phase.rounds.find((round) => round.status === 'open');
  if (unfinished) {
    throw new ProtocolError(
      `cannot open a round: round ${String(unfinished.index)} of ${phase.kind} is still open`,
    );
  }
}

export function assertCanCloseRound(state: ProtocolState, phaseId: string, roundId: string): void {
  const phase = phaseById(state, phaseId);
  const round = phase.rounds.find((candidate) => candidate.roundId === roundId);
  if (!round) throw new ProtocolError(`unknown round: ${roundId}`);
  if (round.status !== 'open') {
    throw new ProtocolError(`round ${roundId} is already ${round.status}`);
  }
}

export function assertCanClosePhase(state: ProtocolState, phaseId: string): void {
  const phase = phaseById(state, phaseId);
  if (phase.status === 'complete' || phase.status === 'failed' || phase.status === 'skipped') {
    throw new ProtocolError(`${phase.kind} is already ${phase.status}`);
  }
  const unfinished = phase.rounds.find((round) => round.status === 'open');
  if (unfinished) {
    throw new ProtocolError(
      `cannot close ${phase.kind}: round ${String(unfinished.index)} is still open`,
    );
  }
}

export function assertCanResolveGate(state: ProtocolState, phaseId: string, gate: GateKind): void {
  const phase = phaseById(state, phaseId);
  if (!phase.gate || phase.gate.gate !== gate) {
    throw new ProtocolError(`${phase.kind} has no ${gate} gate open`);
  }
  if (phase.gate.decision !== null) {
    throw new ProtocolError(`the ${gate} gate was already ${phase.gate.decision}`);
  }
}

function mapPhase(
  state: ProtocolState,
  phaseId: string,
  change: (phase: PhaseState) => PhaseState,
): ProtocolState {
  let touched = false;
  const phases = state.phases.map((phase) => {
    if (phase.phaseId !== phaseId) return phase;
    touched = true;
    return change(phase);
  });
  return touched ? { ...state, phases } : state;
}

function mapRound(
  state: ProtocolState,
  phaseId: string,
  roundId: string,
  change: (round: RoundState) => RoundState,
): ProtocolState {
  return mapPhase(state, phaseId, (phase) => ({
    ...phase,
    rounds: phase.rounds.map((round) => (round.roundId === roundId ? change(round) : round)),
  }));
}

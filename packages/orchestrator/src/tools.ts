import type { DomainEvent, ParticipantRole, RoleAssignment, RoundMode } from '@sheep/core';
import type { OrchestratorPorts, SessionSnapshot } from './ports';
import type { RoleDemand } from './roles';
import type { PhaseState, ProtocolState, RoundState } from './state';

/**
 * What a phase is given to work with.
 *
 * Each phase lives in its own module and is a single function: look at the
 * log, take exactly one step, return. These are the steps it may take. They
 * are the engine's own — the same ones FRAMING and HYPOTHESIS use — so every
 * phase records transitions, dedupes turns and staffs rounds by one set of
 * rules rather than seven.
 */

export interface RoundSpec {
  readonly index: number;
  readonly mode: RoundMode;
  /** Roles for the solver to fill. */
  readonly demands?: readonly RoleDemand[];
  /**
   * Whose work this round reviews. The solver keeps them, and their vendors,
   * out of the critic's chair (P1).
   */
  readonly authors?: readonly string[];
  /**
   * Assignments decided by the protocol rather than the solver: the proposer
   * revising its own method is that proposer, not whoever is next in rotation.
   * Still checked against the hard constraints.
   */
  readonly fixed?: readonly RoleAssignment[];
}

export interface PhaseTools {
  readonly ports: OrchestratorPorts;
  openRound(
    snapshot: SessionSnapshot,
    state: ProtocolState,
    phase: PhaseState,
    spec: RoundSpec,
  ): Promise<void>;
  /** Every assigned participant answers at once, seeing only its own brief (P3). */
  runBlindRound(
    snapshot: SessionSnapshot,
    phase: PhaseState,
    round: RoundState,
    brief: (participantId: string) => string,
  ): Promise<void>;
  /** One turn: asked once, recorded, billed. Returns the recorded text on a retry. */
  runTurn(
    snapshot: SessionSnapshot,
    phase: PhaseState,
    round: RoundState,
    participantId: string,
    role: ParticipantRole,
    prompt: string,
  ): Promise<string>;
  /** `extra` lands in the same batch: recorded if and only if the round closes. */
  closeRound(
    snapshot: SessionSnapshot,
    state: ProtocolState,
    phase: PhaseState,
    round: RoundState,
    extra?: readonly DomainEvent[],
  ): Promise<void>;
  closePhase(
    sessionId: string,
    state: ProtocolState,
    phase: PhaseState,
    outcome: 'complete' | 'failed',
    summary: string,
    extra?: readonly DomainEvent[],
  ): Promise<void>;
}

export interface PhaseContext {
  readonly tools: PhaseTools;
  readonly snapshot: SessionSnapshot;
  readonly state: ProtocolState;
  readonly phase: PhaseState;
}

/** One step of one phase. The engine re-reads the log and calls it again. */
export type PhaseBody = (context: PhaseContext) => Promise<void>;

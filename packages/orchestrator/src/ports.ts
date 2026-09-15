import type {
  DomainEvent,
  MessageFinishReason,
  ModelRef,
  ParticipantRole,
  RosterEntry,
  SessionStatus,
} from '@sheep/core';

/**
 * Everything the orchestrator needs from the outside world, and nothing else.
 *
 * The orchestrator runs in its own process. It owns no database handle and no
 * adapter registry — main owns both, because two owners of either would be two
 * answers to what happened and what it cost. So the protocol logic is written
 * against these four operations, and the process boundary is a detail of which
 * implementation is plugged in: the desktop app supplies one that forwards over
 * JSON-RPC, and the tests supply one backed by an array and a script.
 *
 * That is also what makes Phase 29 cheap. A golden replay is this interface
 * with `ask` reading from a fixture file: the protocol cannot tell the
 * difference, so a recorded session replays through the real engine at zero
 * cost.
 */

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly title: string;
  readonly question: string;
  readonly status: SessionStatus;
  readonly budget: { readonly capUsd: number | null; readonly spentUsd: number };
  /** Attached participants only. Detached models are history, not a roster. */
  readonly roster: readonly RosterEntry[];
  /** This session's events in chain order — the state machine's only input. */
  readonly events: readonly DomainEvent[];
}

export interface TurnRequest {
  readonly participantId: string;
  readonly role: ParticipantRole;
  readonly phaseId: string;
  readonly roundId: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens?: number;
}

export interface TurnResponse {
  readonly text: string;
  readonly model: ModelRef;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
  } | null;
  readonly finish: MessageFinishReason;
  /** What the provider was actually sent, for provenance. */
  readonly params?: { readonly maxOutputTokens: number; readonly temperature?: number };
}

export type ProgressKind =
  | 'phase-opened'
  | 'round-opened'
  | 'turn-recorded'
  | 'round-closed'
  | 'phase-closed'
  | 'gate-raised'
  | 'stopped';

export interface ProgressUpdate {
  readonly sessionId: string;
  readonly kind: ProgressKind;
  readonly detail: string;
}

export interface OrchestratorPorts {
  /** One round trip for everything the engine reads. */
  snapshot(sessionId: string): Promise<SessionSnapshot>;
  /** Appends atomically. The engine never writes anywhere else. */
  record(sessionId: string, events: readonly DomainEvent[]): Promise<void>;
  /**
   * One model turn. Calls the provider; records nothing.
   *
   * The engine hashes the request itself and will not call this twice for the
   * same turn, so an implementation does not need its own idempotency.
   */
  ask(sessionId: string, request: TurnRequest): Promise<TurnResponse>;
  newId(): string;
  /** Best-effort progress for the UI. Never awaited, never load-bearing. */
  progress?(update: ProgressUpdate): void;
}

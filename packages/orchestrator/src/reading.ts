import {
  Ledger,
  type Claim,
  type DomainEvent,
  type ParticipantRole,
  type PhaseKind,
} from '@sheep/core';
import type { SessionSnapshot } from './ports';
import type { PhaseState, ProtocolState, RoundState } from './state';

/**
 * Reading a session back out of its log.
 *
 * A phase holds nothing between steps, so everything it needs to know about
 * what earlier phases produced — the charter, the hypotheses, the method —
 * is read from the events each time. These are the readers they share.
 */

export interface RecordedTurn {
  readonly messageId: string;
  readonly participantId: string;
  readonly role: ParticipantRole | null;
  readonly text: string;
  readonly promptHash: string | null;
}

/** Model turns in one round, in log order. Text bodies only. */
export function turnsOf(events: readonly DomainEvent[], roundId: string): readonly RecordedTurn[] {
  const turns: RecordedTurn[] = [];
  for (const event of events) {
    if (event.type !== 'message.recorded') continue;
    const payload = event.payload;
    if (payload.roundId !== roundId) continue;
    if (payload.author.kind !== 'MODEL') continue;
    if (payload.body.kind !== 'text') continue;
    turns.push({
      messageId: payload.messageId,
      participantId: payload.author.participantId,
      role: payload.role ?? null,
      text: payload.body.text,
      promptHash: payload.promptHash ?? null,
    });
  }
  return turns;
}

/** The approved charter, which every later phase is written against. */
export function charterOf(snapshot: SessionSnapshot): string {
  for (let i = snapshot.events.length - 1; i >= 0; i -= 1) {
    const event = snapshot.events[i];
    if (event?.type === 'phase.gate-raised' && event.payload.gate === 'charter') {
      return event.payload.proposal;
    }
  }
  throw new Error('no charter has been drafted; FRAMING must run first');
}

/** A finished phase of a given kind. Throws when the session has not got there. */
export function completedPhase(state: ProtocolState, kind: PhaseKind): PhaseState {
  const phase = state.phases.find((candidate) => candidate.kind === kind);
  if (!phase || phase.status !== 'complete') throw new Error(`${kind} has not completed`);
  return phase;
}

/**
 * The session's ledger, replayed from the snapshot.
 *
 * The snapshot carries events without their timestamps, and nothing a phase
 * decides depends on when a claim was recorded, so a fixed instant stands in.
 */
export function ledgerOf(snapshot: SessionSnapshot): Ledger {
  return Ledger.replay(
    snapshot.sessionId,
    snapshot.events.map((event) => ({ event, recordedAt: '1970-01-01T00:00:00.000Z' })),
  );
}

export interface LabelledClaim {
  /** What the claim is called in a prompt: `H1`, `C2`. Stable for a given log. */
  readonly label: string;
  readonly claim: Claim;
}

/** Claims recorded by one phase, labelled in the order they were recorded. */
export function claimsOfPhase(
  snapshot: SessionSnapshot,
  phase: PhaseState,
  prefix: string,
): LabelledClaim[] {
  return ledgerOf(snapshot)
    .claims()
    .filter((claim) => claim.phaseId === phase.phaseId)
    .map((claim, index) => ({ label: `${prefix}${String(index + 1)}`, claim }));
}

/** The hypotheses a human selected at the HYPOTHESIS gate. */
export function hypothesesOf(snapshot: SessionSnapshot, state: ProtocolState): LabelledClaim[] {
  return claimsOfPhase(snapshot, completedPhase(state, 'HYPOTHESIS'), 'H');
}

/** The one participant holding a role in a round. */
export function holderOf(round: RoundState, role: ParticipantRole): string {
  for (const [participantId, held] of round.assignments) {
    if (held === role) return participantId;
  }
  throw new Error(`no ${role} was assigned to this round`);
}

/** Text clipped for a prompt, saying so when it was. */
export function clip(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[… ${String(text.length - limit)} more characters not shown]`;
}

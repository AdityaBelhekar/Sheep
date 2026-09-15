import { createHash } from 'node:crypto';
import {
  domainEvent,
  type DomainEvent,
  type GateDecision,
  type GateKind,
  type GateOption,
  type ParticipantRole,
  type PhaseKind,
  type RoleAssignment,
  type RosterEntry,
  type SessionStatus,
} from '@sheep/core';
import { runBlindParallel } from './blind';
import type { OrchestratorPorts, SessionSnapshot, TurnRequest } from './ports';
import {
  charterPrompt,
  framingStatementPrompt,
  hypothesisListSchema,
  hypothesisPrompt,
  hypothesisScoresSchema,
  hypothesisScoringPrompt,
  ModelOutputError,
  parseJsonReply,
  systemFor,
} from './prompts';
import { solveRoles, UnsatisfiableRolesError, type SolverParticipant } from './roles';
import { clusterTexts, type ClusterItem } from './similarity';
import {
  assertCanCloseRound,
  assertCanOpenPhase,
  assertCanOpenRound,
  assertCanResolveGate,
  nextPhaseKind,
  openPhase,
  pendingGate,
  phaseById,
  reduceProtocol,
  type PhaseState,
  type ProtocolState,
  type RoundState,
} from './state';
import { shouldTerminate, type TerminationReason, type TerminationRules } from './termination';

/**
 * The session driver.
 *
 * Every iteration of `run` re-reads the log, rebuilds the protocol state from
 * it, and takes exactly one step. That is slower than holding state in memory
 * and it is the entire point: a step is only ever taken against what is
 * durably recorded, so killing the process at any instant and starting again
 * resumes from the same place. Resume is not a feature bolted on in Phase 29 —
 * it is what the loop already does every time round.
 *
 * Two phases are implemented here: FRAMING and HYPOTHESIS, the two that end at
 * a human gate. The rest need the sandbox and the verifier, so the loop stops
 * cleanly at the first phase it cannot run rather than pretending to.
 */

export interface OrchestratorOptions {
  readonly rules?: Partial<TerminationRules>;
  /** Makes role tie-breaks deterministic across replays. */
  readonly seed?: string;
  readonly concurrency?: number;
  /** Cap on steps per `run` call. A stuck loop should stop, not spin. */
  readonly maxSteps?: number;
}

export type RunStatus = 'awaiting-approval' | 'stopped' | 'complete' | 'failed';

export interface RunOutcome {
  readonly status: RunStatus;
  readonly reason: TerminationReason | 'gate' | 'not-implemented' | 'error' | null;
  readonly detail: string;
  readonly state: ProtocolView;
}

/**
 * A serialisable view of the protocol state, for IPC and for the UI.
 *
 * Deliberately a plain mutable DTO rather than the deep-readonly internal
 * state: it is about to be structured-cloned across a process boundary and
 * handed to React, and a readonly type on a copy nobody owns buys nothing while
 * making it awkward to validate against a schema on the way out.
 */
export interface ProtocolRoundView {
  roundId: string;
  index: number;
  mode: RoundState['mode'];
  status: RoundState['status'];
  assignments: RoleAssignment[];
  spoke: string[];
}

export interface ProtocolGateView {
  gate: GateKind;
  proposal: string;
  options: GateOption[];
  decision: GateDecision | null;
  selected: string[];
  note: string | null;
}

export interface ProtocolPhaseView {
  phaseId: string;
  kind: PhaseKind;
  index: number;
  status: PhaseState['status'];
  summary: string | null;
  rounds: ProtocolRoundView[];
  gate: ProtocolGateView | null;
}

export interface ProtocolView {
  sessionId: string;
  status: SessionStatus;
  nextPhase: PhaseKind | null;
  phases: ProtocolPhaseView[];
}

export interface ApproveInput {
  readonly gate: GateKind;
  readonly decision: GateDecision;
  readonly selected?: readonly string[];
  readonly note?: string;
}

/** Phases this stage can actually run. The rest wait for the sandbox. */
const IMPLEMENTED: ReadonlySet<PhaseKind> = new Set<PhaseKind>(['FRAMING', 'HYPOTHESIS']);

/** A ceiling on one call's work, not a target. */
const DEFAULT_MAX_STEPS = 64;

/** Bounded so one runaway model cannot fill the log with a single turn. */
const MAX_TURN_CHARS = 60_000;

export class Orchestrator {
  readonly #ports: OrchestratorPorts;
  readonly #options: OrchestratorOptions;
  readonly #cancelled = new Set<string>();

  constructor(ports: OrchestratorPorts, options: OrchestratorOptions = {}) {
    this.#ports = ports;
    this.#options = options;
  }

  /**
   * Starts a session, or carries on one that was interrupted.
   *
   * There is no separate `resume`: starting and resuming are the same act,
   * because the loop derives everything it knows from the log either way.
   */
  async run(sessionId: string): Promise<RunOutcome> {
    this.#cancelled.delete(sessionId);
    const maxSteps = this.#options.maxSteps ?? DEFAULT_MAX_STEPS;

    for (let step = 0; step < maxSteps; step += 1) {
      const snapshot = await this.#ports.snapshot(sessionId);
      const state = reduceProtocol(sessionId, snapshot.events);

      if (this.#cancelled.has(sessionId)) {
        return this.#stop(state, 'cancelled', 'the session was cancelled');
      }

      const gate = pendingGate(state);
      if (gate) {
        return {
          status: 'awaiting-approval',
          reason: 'gate',
          detail: `waiting for approval of the ${gate.gate.gate}`,
          state: toProtocolView(state),
        };
      }

      const phase = openPhase(state);
      if (!phase) {
        const kind = nextPhaseKind(state);
        if (kind === null) {
          await this.#setStatus(sessionId, state, 'complete');
          const finished = reduceProtocol(
            sessionId,
            (await this.#ports.snapshot(sessionId)).events,
          );
          return {
            status: 'complete',
            reason: null,
            detail: 'every phase in the sequence has finished',
            state: toProtocolView(finished),
          };
        }
        if (!IMPLEMENTED.has(kind)) {
          return {
            status: 'stopped',
            reason: 'not-implemented',
            detail: `${kind} needs the execution sandbox and the verifier (Stages 6–8)`,
            state: toProtocolView(state),
          };
        }
        await this.#openPhase(snapshot, state, kind);
        continue;
      }

      if (snapshot.roster.length === 0) {
        return this.#fail(sessionId, state, phase, 'no models are attached to this session');
      }

      try {
        await this.#stepPhase(snapshot, state, phase);
      } catch (error) {
        if (error instanceof StopPhase) {
          await this.#closePhase(sessionId, state, phase, 'complete', error.detail);
          return this.#stop(
            reduceProtocol(sessionId, (await this.#ports.snapshot(sessionId)).events),
            error.reason,
            error.detail,
          );
        }
        const detail = error instanceof Error ? error.message : String(error);
        return this.#fail(sessionId, state, phase, detail);
      }
    }

    const state = reduceProtocol(sessionId, (await this.#ports.snapshot(sessionId)).events);
    return {
      status: 'stopped',
      reason: 'round-cap',
      detail: `stopped after ${String(maxSteps)} steps without reaching a gate`,
      state: toProtocolView(state),
    };
  }

  /** Answers an open gate, then carries on. */
  async approve(sessionId: string, input: ApproveInput): Promise<RunOutcome> {
    const snapshot = await this.#ports.snapshot(sessionId);
    const state = reduceProtocol(sessionId, snapshot.events);
    const pending = pendingGate(state);
    if (!pending) throw new Error('there is no gate waiting for approval');
    assertCanResolveGate(state, pending.phase.phaseId, input.gate);

    await this.#ports.record(sessionId, [
      domainEvent('phase.gate-resolved', {
        sessionId,
        phaseId: pending.phase.phaseId,
        gate: input.gate,
        decision: input.decision,
        ...(input.selected === undefined ? {} : { selected: [...input.selected] }),
        ...(input.note === undefined ? {} : { note: input.note }),
      }),
    ]);
    return await this.run(sessionId);
  }

  /**
   * Stops the loop at the next step boundary.
   *
   * A turn already in flight is allowed to finish and be recorded: it has been
   * paid for, and throwing it away would leave the log describing a call that
   * happened as one that did not.
   */
  cancel(sessionId: string): void {
    this.#cancelled.add(sessionId);
  }

  async view(sessionId: string): Promise<ProtocolView> {
    const snapshot = await this.#ports.snapshot(sessionId);
    return toProtocolView(reduceProtocol(sessionId, snapshot.events));
  }

  // -------------------------------------------------------------------------
  // Phase bodies. Each takes exactly one step, then the loop re-reads the log.
  // -------------------------------------------------------------------------

  async #stepPhase(
    snapshot: SessionSnapshot,
    state: ProtocolState,
    phase: PhaseState,
  ): Promise<void> {
    if (phase.kind === 'FRAMING') return await this.#stepFraming(snapshot, state, phase);
    if (phase.kind === 'HYPOTHESIS') return await this.#stepHypothesis(snapshot, state, phase);
    throw new Error(`${phase.kind} is not implemented in this stage`);
  }

  /**
   * FRAMING: independent problem statements, then a referee's charter, then a
   * human.
   *
   * Round 0 is blind-parallel and is the phase's whole reason for existing — a
   * charter drafted from four independent framings is a different object from
   * one drafted from four models agreeing with the first one to speak.
   */
  async #stepFraming(
    snapshot: SessionSnapshot,
    state: ProtocolState,
    phase: PhaseState,
  ): Promise<void> {
    const statements = phase.rounds.find((round) => round.index === 0);

    if (!statements) {
      await this.#openRound(snapshot, state, phase, 0, 'BLIND_PARALLEL', [
        { role: 'PROPOSER', count: snapshot.roster.length },
      ]);
      return;
    }

    if (statements.status === 'open') {
      await this.#runBlindRound(snapshot, phase, statements, () =>
        framingStatementPrompt(snapshot.question),
      );
      await this.#closeRound(snapshot, state, phase, statements);
      return;
    }

    const drafts = phase.rounds.filter((round) => round.index > 0);
    const latest = drafts[drafts.length - 1];

    if (!latest || latest.status !== 'open') {
      // A charter that has been approved is the end of the phase; one that was
      // rejected is redrafted with the human's note in front of the referee.
      if (phase.gate?.decision === 'approved') {
        await this.#closePhase(
          snapshot.sessionId,
          state,
          phase,
          'complete',
          'the charter was approved',
        );
        return;
      }
      this.#assertMayContinue(snapshot, phase, drafts.length);
      await this.#openRound(snapshot, state, phase, phase.rounds.length, 'SEQUENTIAL', [
        { role: 'REFEREE', count: 1 },
      ]);
      return;
    }

    const clusters = clusterTexts(
      turnsOf(snapshot.events, statements.roundId).map((turn) => ({
        id: turn.messageId,
        text: turn.text,
        source: turn.participantId,
      })),
    );
    const note = phase.gate?.decision === 'rejected' ? (phase.gate.note ?? undefined) : undefined;
    const prompt = charterPrompt(
      snapshot.question,
      clusters.map((cluster) => ({
        label: cluster.representative.id,
        support: cluster.sources.length,
        text: cluster.representative.text,
      })),
      note,
    );

    const referee = refereeOf(latest);
    const charter = await this.#runTurn(snapshot, phase, latest, referee, 'REFEREE', prompt);
    await this.#closeRound(snapshot, state, phase, latest);
    await this.#raiseGate(snapshot, phase, 'charter', charter);
  }

  /**
   * HYPOTHESIS: blind generation, clustering, blind scoring, then a human picks.
   *
   * Scoring is blind for the same reason generation is, and matters more: a
   * visible score is an anchor, and a roster that can see each other's numbers
   * produces a consensus about the numbers rather than an estimate of the
   * hypotheses. The aggregate never decides anything — it orders the list the
   * human chooses from.
   */
  async #stepHypothesis(
    snapshot: SessionSnapshot,
    state: ProtocolState,
    phase: PhaseState,
  ): Promise<void> {
    if (phase.gate?.decision === 'approved') {
      await this.#closePhase(
        snapshot.sessionId,
        state,
        phase,
        'complete',
        'hypotheses were selected',
        this.#selectedHypothesisClaims(snapshot, phase),
      );
      return;
    }

    const charter = charterOf(snapshot);
    const rounds = phase.rounds;
    const open = rounds.find((round) => round.status === 'open');

    if (!open) {
      // Rounds go in generate/score pairs, so a rejected gate simply starts a
      // fresh pair rather than needing a mode of its own.
      const generating = rounds.length % 2 === 0;
      this.#assertMayContinue(snapshot, phase, Math.floor(rounds.length / 2));
      await this.#openRound(snapshot, state, phase, rounds.length, 'BLIND_PARALLEL', [
        { role: generating ? 'PROPOSER' : 'VERIFIER', count: snapshot.roster.length },
      ]);
      return;
    }

    if (open.index % 2 === 0) {
      await this.#runBlindRound(snapshot, phase, open, () => hypothesisPrompt(charter));
      await this.#closeRound(snapshot, state, phase, open);
      return;
    }

    const candidates = candidatesFrom(snapshot, phase, open.index - 1);
    if (candidates.length === 0) {
      throw new Error('no usable hypotheses were proposed');
    }

    await this.#runBlindRound(snapshot, phase, open, () =>
      hypothesisScoringPrompt(charter, candidates),
    );
    await this.#closeRound(snapshot, state, phase, open);

    const scored = rankCandidates(candidates, turnsOf(snapshot.events, open.roundId), snapshot);
    const options: GateOption[] = scored.map((entry) => ({
      optionId: this.#ports.newId(),
      label: entry.label.slice(0, 200),
      detail: entry.detail.slice(0, 20_000),
      score: entry.score,
    }));

    await this.#raiseGate(
      snapshot,
      phase,
      'hypothesis',
      `${String(options.length)} candidate hypotheses, ranked by the roster's blind scores. ` +
        `Select the ones this session will pursue.`,
      options,
    );
  }

  // -------------------------------------------------------------------------
  // Steps, each of which records what it did before returning
  // -------------------------------------------------------------------------

  async #openPhase(
    snapshot: SessionSnapshot,
    state: ProtocolState,
    kind: PhaseKind,
  ): Promise<void> {
    assertCanOpenPhase(state, kind);
    const phaseId = this.#ports.newId();
    const events: DomainEvent[] = [
      domainEvent('phase.opened', {
        sessionId: snapshot.sessionId,
        phaseId,
        kind,
        index: state.phases.length,
      }),
    ];
    if (state.status === 'draft') {
      events.unshift(
        domainEvent('session.status-changed', { sessionId: snapshot.sessionId, status: 'running' }),
      );
    }
    await this.#ports.record(snapshot.sessionId, events);
    this.#report(snapshot.sessionId, 'phase-opened', `${kind} opened`);
  }

  async #openRound(
    snapshot: SessionSnapshot,
    state: ProtocolState,
    phase: PhaseState,
    index: number,
    mode: 'BLIND_PARALLEL' | 'SEQUENTIAL' | 'COLLECTIVE',
    demands: readonly { role: ParticipantRole; count: number }[],
  ): Promise<void> {
    assertCanOpenRound(state, phase.phaseId);
    const roundId = this.#ports.newId();

    let assignments: readonly RoleAssignment[];
    try {
      assignments = solveRoles({
        participants: snapshot.roster.map(toSolverParticipant),
        demands,
        history: state.roleHistory,
        ...(this.#options.seed === undefined ? {} : { seed: this.#options.seed }),
      }).assignments;
    } catch (error) {
      if (error instanceof UnsatisfiableRolesError) {
        // Loud rather than silently relaxed: an assignment that broke P1 would
        // make everything downstream of it worthless while still looking fine.
        throw new Error(`${phase.kind} cannot be staffed: ${error.detail}`, { cause: error });
      }
      throw error;
    }

    await this.#ports.record(snapshot.sessionId, [
      domainEvent('round.opened', {
        sessionId: snapshot.sessionId,
        phaseId: phase.phaseId,
        roundId,
        index,
        mode,
      }),
      domainEvent('roster.roles-assigned', {
        sessionId: snapshot.sessionId,
        phaseId: phase.phaseId,
        roundId,
        assignments: [...assignments],
      }),
    ]);
    this.#report(
      snapshot.sessionId,
      'round-opened',
      `${phase.kind} round ${String(index)} (${mode})`,
    );
  }

  async #closeRound(
    snapshot: SessionSnapshot,
    state: ProtocolState,
    phase: PhaseState,
    round: RoundState,
  ): Promise<void> {
    assertCanCloseRound(state, phase.phaseId, round.roundId);
    await this.#ports.record(snapshot.sessionId, [
      domainEvent('round.closed', {
        sessionId: snapshot.sessionId,
        phaseId: phase.phaseId,
        roundId: round.roundId,
        outcome: 'complete',
      }),
    ]);
    this.#report(
      snapshot.sessionId,
      'round-closed',
      `${phase.kind} round ${String(round.index)} closed`,
    );
  }

  async #closePhase(
    sessionId: string,
    state: ProtocolState,
    phase: PhaseState,
    outcome: 'complete' | 'failed',
    summary: string,
    /** Recorded in the same batch, so they land if and only if the phase closes. */
    extra: readonly DomainEvent[] = [],
  ): Promise<void> {
    const current = phaseById(state, phase.phaseId);
    if (current.status === 'complete' || current.status === 'failed') {
      throw new Error(`${current.kind} is already ${current.status}`);
    }
    // Any round still open is aborted rather than left dangling: a phase that
    // failed mid-round must not leave the log describing a round that never
    // ended.
    const events: DomainEvent[] = current.rounds
      .filter((round) => round.status === 'open')
      .map((round) =>
        domainEvent('round.closed', {
          sessionId,
          phaseId: phase.phaseId,
          roundId: round.roundId,
          outcome: 'aborted',
        }),
      );
    events.push(
      ...extra,
      domainEvent('phase.closed', { sessionId, phaseId: phase.phaseId, outcome, summary }),
    );
    await this.#ports.record(sessionId, events);
    this.#report(sessionId, 'phase-closed', `${phase.kind} ${outcome}: ${summary}`);
  }

  /**
   * The hypotheses a human selected, as CONJECTURE claims in the ledger.
   *
   * Conjecture is the honest type: nothing has been run or derived yet. Each
   * claim names the turn and participant that proposed it, so its provenance
   * survives the clustering that merged duplicates. The gate's options were
   * raised from the same log in the same order, so they are matched back to
   * their candidates by position — and by label, in case they ever are not.
   */
  #selectedHypothesisClaims(snapshot: SessionSnapshot, phase: PhaseState): DomainEvent[] {
    const gate = phase.gate;
    const scoring = phase.rounds.filter((round) => round.index % 2 === 1).at(-1);
    if (!gate || !scoring) return [];

    const ranked = rankCandidates(
      candidatesFrom(snapshot, phase, scoring.index - 1),
      turnsOf(snapshot.events, scoring.roundId),
      snapshot,
    );
    return gate.options.flatMap((option, index) => {
      const candidate = ranked[index];
      if (!gate.selected.includes(option.optionId)) return [];
      if (!candidate || candidate.label.slice(0, 200) !== option.label) return [];
      return [
        domainEvent('claim.recorded', {
          sessionId: snapshot.sessionId,
          claimId: this.#ports.newId(),
          claimType: 'CONJECTURE',
          statement: option.label,
          phaseId: phase.phaseId,
          messageId: candidate.messageId,
          authorParticipantId: candidate.participantId,
        }),
      ];
    });
  }

  async #raiseGate(
    snapshot: SessionSnapshot,
    phase: PhaseState,
    gate: GateKind,
    proposal: string,
    options?: readonly GateOption[],
  ): Promise<void> {
    await this.#ports.record(snapshot.sessionId, [
      domainEvent('phase.gate-raised', {
        sessionId: snapshot.sessionId,
        phaseId: phase.phaseId,
        gate,
        proposal: proposal.slice(0, 20_000),
        ...(options === undefined ? {} : { options: [...options] }),
      }),
    ]);
    this.#report(snapshot.sessionId, 'gate-raised', `${gate} awaiting approval`);
  }

  async #setStatus(
    sessionId: string,
    state: ProtocolState,
    status: SessionStatus,
    reason?: string,
  ): Promise<void> {
    if (state.status === status) return;
    await this.#ports.record(sessionId, [
      domainEvent('session.status-changed', {
        sessionId,
        status,
        ...(reason === undefined ? {} : { reason }),
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  /** Every assigned participant answers at once, seeing only the shared brief. */
  async #runBlindRound(
    snapshot: SessionSnapshot,
    phase: PhaseState,
    round: RoundState,
    brief: (participantId: string) => string,
  ): Promise<void> {
    // Participants that already spoke are skipped, which is what makes a
    // crashed round resumable without paying for the turns that survived.
    const outstanding = [...round.assignments.keys()].filter((id) => !round.spoke.includes(id));

    const result = await runBlindParallel(
      outstanding,
      async (participantId) => {
        const role = round.assignments.get(participantId) ?? 'PROPOSER';
        return await this.#runTurn(
          snapshot,
          phase,
          round,
          participantId,
          role,
          brief(participantId),
        );
      },
      this.#options.concurrency === undefined ? {} : { concurrency: this.#options.concurrency },
    );

    // `reveal` is what enforces commit-then-reveal: nothing below this line can
    // read an answer until every participant has committed one.
    const settled = result.reveal();
    if (settled.every((turn) => turn.value === null) && settled.length > 0) {
      const first = settled[0]?.error;
      throw new Error(`every model failed this round: ${first?.message ?? 'unknown error'}`);
    }
  }

  /** One turn: call, record, and bill. Skipped entirely if it was already answered. */
  async #runTurn(
    snapshot: SessionSnapshot,
    phase: PhaseState,
    round: RoundState,
    participantId: string,
    role: ParticipantRole,
    prompt: string,
  ): Promise<string> {
    const participant = snapshot.roster.find((entry) => entry.participantId === participantId);
    if (!participant) throw new Error(`participant ${participantId} is not on the roster`);

    const system = systemFor(role);
    const request: TurnRequest = {
      participantId,
      role,
      phaseId: phase.phaseId,
      roundId: round.roundId,
      system,
      prompt,
    };

    // The dedupe key is the request, not the attempt: a retry after a crash
    // rebuilds byte-identical inputs and so is recognised as the same turn.
    const promptHash = hashRequest(request, participant);
    const existing = turnsOf(snapshot.events, round.roundId).find(
      (turn) => turn.promptHash === promptHash,
    );
    if (existing) return existing.text;

    const response = await this.#ports.ask(snapshot.sessionId, request);
    const text = response.text.slice(0, MAX_TURN_CHARS);
    const messageId = this.#ports.newId();

    const events: DomainEvent[] = [
      domainEvent('message.recorded', {
        sessionId: snapshot.sessionId,
        messageId,
        phaseId: phase.phaseId,
        roundId: round.roundId,
        author: { kind: 'MODEL', participantId, model: response.model },
        role,
        body: { kind: 'text', text },
        ...(response.usage ? { usage: response.usage } : {}),
        finish: response.finish,
        promptHash,
      }),
    ];
    if (response.usage && response.usage.costUsd > 0) {
      events.push(
        domainEvent('session.spend-recorded', {
          sessionId: snapshot.sessionId,
          costUsd: response.usage.costUsd,
          messageId,
        }),
      );
    }
    await this.#ports.record(snapshot.sessionId, events);
    this.#report(snapshot.sessionId, 'turn-recorded', `${role} answered in ${phase.kind}`);
    return text;
  }

  // -------------------------------------------------------------------------

  /** Budget, round cap and loop detection, checked before another round is paid for. */
  #assertMayContinue(snapshot: SessionSnapshot, phase: PhaseState, roundsCompleted: number): void {
    const roundTexts = phase.rounds
      .filter((round) => round.status === 'complete')
      .map((round) => turnsOf(snapshot.events, round.roundId).map((turn) => turn.text));

    const verdict = shouldTerminate({
      roundsCompleted,
      roundTexts,
      budget: snapshot.budget,
      ...(this.#options.rules === undefined ? {} : { rules: this.#options.rules }),
    });
    if (verdict.stop && verdict.reason !== null)
      throw new StopPhase(verdict.reason, verdict.detail);
  }

  #stop(state: ProtocolState, reason: TerminationReason, detail: string): RunOutcome {
    return { status: 'stopped', reason, detail, state: toProtocolView(state) };
  }

  async #fail(
    sessionId: string,
    state: ProtocolState,
    phase: PhaseState,
    detail: string,
  ): Promise<RunOutcome> {
    await this.#closePhase(sessionId, state, phase, 'failed', detail.slice(0, 20_000));
    const after = reduceProtocol(sessionId, (await this.#ports.snapshot(sessionId)).events);
    await this.#setStatus(sessionId, after, 'failed', detail.slice(0, 20_000));
    return {
      status: 'failed',
      reason: 'error',
      detail,
      state: toProtocolView(
        reduceProtocol(sessionId, (await this.#ports.snapshot(sessionId)).events),
      ),
    };
  }

  #report(
    sessionId: string,
    kind: Parameters<NonNullable<OrchestratorPorts['progress']>>[0]['kind'],
    detail: string,
  ): void {
    this.#ports.progress?.({ sessionId, kind, detail });
  }
}

/** Thrown by a termination check; caught by the loop, which closes the phase. */
class StopPhase extends Error {
  constructor(
    readonly reason: TerminationReason,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'StopPhase';
  }
}

// ---------------------------------------------------------------------------
// Reading turns back out of the log
// ---------------------------------------------------------------------------

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

/** The approved charter, which HYPOTHESIS is written against. */
function charterOf(snapshot: SessionSnapshot): string {
  for (let i = snapshot.events.length - 1; i >= 0; i -= 1) {
    const event = snapshot.events[i];
    if (event?.type === 'phase.gate-raised' && event.payload.gate === 'charter') {
      return event.payload.proposal;
    }
  }
  throw new Error('no charter has been drafted; FRAMING must run first');
}

interface Candidate {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  /** The turn and participant behind the cluster's representative. */
  readonly messageId: string;
  readonly participantId: string;
}

/** Hypotheses proposed in a generation round, clustered so duplicates count once. */
function candidatesFrom(
  snapshot: SessionSnapshot,
  phase: PhaseState,
  roundIndex: number,
): Candidate[] {
  const round = phase.rounds.find((candidate) => candidate.index === roundIndex);
  if (!round) return [];

  const items: (ClusterItem & {
    detail: string;
    label: string;
    messageId: string;
    source: string;
  })[] = [];
  for (const turn of turnsOf(snapshot.events, round.roundId)) {
    let parsed;
    try {
      parsed = parseJsonReply(turn.text, hypothesisListSchema, turn.participantId);
    } catch (error) {
      // One model replying in prose does not invalidate the others' JSON. The
      // loss is visible in the log, where the raw turn is still recorded.
      if (error instanceof ModelOutputError) continue;
      throw error;
    }
    for (const [index, hypothesis] of parsed.hypotheses.entries()) {
      items.push({
        id: `${turn.messageId}:${String(index)}`,
        text: `${hypothesis.label} ${hypothesis.detail ?? ''}`,
        source: turn.participantId,
        label: hypothesis.label,
        detail: hypothesis.detail ?? hypothesis.label,
        messageId: turn.messageId,
      });
    }
  }

  return clusterTexts(items).map((cluster, index) => {
    const representative = cluster.representative as (typeof items)[number];
    return {
      id: `H${String(index + 1)}`,
      label: representative.label,
      messageId: representative.messageId,
      participantId: representative.source,
      detail: `${representative.detail}\n\nProposed independently by ${String(cluster.sources.length)} participant(s).`,
    };
  });
}

interface RankedCandidate extends Candidate {
  readonly score: number;
}

/**
 * Aggregates the blind scores into an order.
 *
 * Weighted by each participant's roster weight, and only ever used to sort the
 * list a human chooses from — the number is a summary of opinion, not evidence,
 * and nothing in Sheep lets it decide anything by itself.
 */
function rankCandidates(
  candidates: readonly Candidate[],
  scoringTurns: readonly RecordedTurn[],
  snapshot: SessionSnapshot,
): RankedCandidate[] {
  const weights = new Map(
    snapshot.roster.map((entry) => [entry.participantId, entry.weight > 0 ? entry.weight : 1]),
  );
  const totals = new Map<string, { score: number; weight: number }>();

  for (const turn of scoringTurns) {
    let parsed;
    try {
      parsed = parseJsonReply(turn.text, hypothesisScoresSchema, turn.participantId);
    } catch (error) {
      if (error instanceof ModelOutputError) continue;
      throw error;
    }
    const weight = weights.get(turn.participantId) ?? 1;
    for (const score of parsed.scores) {
      const mean = (score.testability + score.novelty + score.feasibility) / 3;
      const running = totals.get(score.id) ?? { score: 0, weight: 0 };
      totals.set(score.id, {
        score: running.score + mean * weight,
        weight: running.weight + weight,
      });
    }
  }

  return candidates
    .map((candidate) => {
      const total = totals.get(candidate.id);
      return {
        ...candidate,
        score: total && total.weight > 0 ? total.score / total.weight : 0,
      };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function refereeOf(round: RoundState): string {
  for (const [participantId, role] of round.assignments) {
    if (role === 'REFEREE') return participantId;
  }
  throw new Error('no referee was assigned to this round');
}

function toSolverParticipant(entry: RosterEntry): SolverParticipant {
  return {
    participantId: entry.participantId,
    vendorId: entry.model.vendorId,
    weight: entry.weight,
    preferredRole: entry.preferredRole,
  };
}

/**
 * The dedupe key: everything that determines what the provider is asked.
 *
 * Fixed key order and no timestamps, so the same turn hashes the same on a
 * retry, on a resume and on a replay — which is the whole mechanism behind
 * "killing the app mid-session resumes at the last committed turn".
 */
export function hashRequest(request: TurnRequest, participant: RosterEntry): string {
  const canonical = JSON.stringify([
    request.phaseId,
    request.roundId,
    request.participantId,
    request.role,
    participant.model.vendorId,
    participant.model.modelId,
    request.system,
    request.prompt,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function toProtocolView(state: ProtocolState): ProtocolView {
  return {
    sessionId: state.sessionId,
    status: state.status,
    nextPhase: nextPhaseKind(state),
    phases: state.phases.map((phase) => ({
      phaseId: phase.phaseId,
      kind: phase.kind,
      index: phase.index,
      status: phase.status,
      summary: phase.summary,
      rounds: phase.rounds.map((round) => ({
        roundId: round.roundId,
        index: round.index,
        mode: round.mode,
        status: round.status,
        assignments: [...round.assignments].map(([participantId, role]) => ({
          participantId,
          role,
        })),
        spoke: [...round.spoke],
      })),
      gate: phase.gate
        ? {
            gate: phase.gate.gate,
            proposal: phase.gate.proposal,
            options: [...phase.gate.options],
            decision: phase.gate.decision,
            selected: [...phase.gate.selected],
            note: phase.gate.note,
          }
        : null,
    })),
  };
}

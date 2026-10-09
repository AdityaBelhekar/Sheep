import type { RunCodeResult, SessionSnapshot } from './ports';
import {
  METHOD_AXES,
  methodCritiquePrompt,
  methodCritiquesSchema,
  methodPrompt,
  methodSchema,
  ModelOutputError,
  parseJsonReply,
  type MethodCritique,
} from './prompts';
import { charterOf, clip, holderOf, hypothesesOf, turnsOf } from './reading';
import type { PhaseState, RoundState } from './state';
import type { PhaseBody } from './tools';

/**
 * METHOD: an executable protocol, attacked before it is run.
 *
 * One participant drafts a method — a plan, and the script that carries it
 * out. Every model from another vendor then attacks it, blind and along six
 * fixed axes, and the author revises against what they said. Nothing here is
 * taken on trust: the script is smoke-run in the sandbox after each draft, and
 * a method only leaves this phase once a program has started it and it did
 * not fall over. Whether a method is *runnable* is not something a model is
 * asked.
 *
 * Rounds: a draft, one blind critique, then revisions until one runs.
 */

/** Long enough to import the libraries and reach the work. Not a full run. */
export const SMOKE_TIMEOUT_MS = 30_000;

/**
 * Drafts before the phase gives up. A proposer that cannot produce a script
 * that starts in this many attempts is not converging, and saying so is more
 * useful than a fifth attempt.
 */
export const MAX_METHOD_DRAFTS = 4;

export interface Method {
  readonly plan: string;
  readonly analysis: string;
  readonly code: string;
  readonly seed: number;
  /** The participant whose method it is. */
  readonly authorId: string;
  readonly messageId: string;
}

/**
 * Reads a method out of a proposer's reply.
 *
 * The script is taken from a fenced block rather than a JSON string: a model
 * asked to escape two hundred lines of Python into one string gets it wrong
 * often enough to matter, and a fenced block is how it writes code anyway.
 */
export function parseMethod(text: string, authorId: string, messageId: string): Method {
  const parsed = parseJsonReply(text, methodSchema, authorId);
  const fenced = /```(?:python|py)?[ \t]*\r?\n([\s\S]*?)```/.exec(text)?.[1];
  const code = (fenced ?? parsed.code ?? '').trim();
  if (code === '') {
    throw new ModelOutputError(authorId, 'the reply contained no fenced python block');
  }
  return {
    plan: parsed.plan,
    analysis: parsed.analysis,
    code: `${code}\n`,
    seed: parsed.seed ?? 0,
    authorId,
    messageId,
  };
}

const holds = (round: RoundState, role: 'PROPOSER' | 'CRITIC'): boolean =>
  [...round.assignments.values()].includes(role);

/** The proposer's rounds, oldest first: the draft and every revision. */
function draftRounds(phase: PhaseState): RoundState[] {
  return phase.rounds.filter((round) => holds(round, 'PROPOSER'));
}

/**
 * The method a session will execute: the latest draft that could be read.
 *
 * Read from the log by every later phase, so that what is run, critiqued and
 * written up is the method that was recorded and not a copy held in memory.
 */
export function finalMethod(snapshot: SessionSnapshot, phase: PhaseState): Method {
  for (const round of draftRounds(phase).reverse()) {
    const turn = turnsOf(snapshot.events, round.roundId).at(-1);
    if (!turn) continue;
    try {
      return parseMethod(turn.text, turn.participantId, turn.messageId);
    } catch (error) {
      if (!(error instanceof ModelOutputError)) throw error;
    }
  }
  throw new Error('METHOD produced no readable method');
}

/** What a run showed, in words a model and a person can both act on. */
export function describeRun(run: RunCodeResult): string {
  const { execution } = run;
  if (execution.status === 'ok') {
    return `The script ran to completion in ${String(execution.durationMs)} ms.`;
  }
  if (execution.status === 'timeout') {
    return `The script started and was still running without error after ${String(
      Math.round(execution.limits.timeoutMs / 1000),
    )} s, when it was stopped.`;
  }
  const tail = clip(run.stderr.trim().split('\n').slice(-12).join('\n'), 2_000);
  return `The script failed (${execution.status}, exit code ${String(execution.exitCode)}):\n${tail}`;
}

/** Started without error. Still running at the smoke limit counts: it had not failed. */
const runnable = (run: RunCodeResult): boolean =>
  run.execution.status === 'ok' || run.execution.status === 'timeout';

export const stepMethod: PhaseBody = async ({ tools, snapshot, state, phase }) => {
  const charter = charterOf(snapshot);
  const hypotheses = hypothesesOf(snapshot, state);
  if (hypotheses.length === 0) {
    throw new Error('no hypotheses were selected, so there is nothing to design a method for');
  }

  const open = phase.rounds.find((round) => round.status === 'open');
  const drafts = draftRounds(phase);
  const finished = drafts.filter((round) => round.status === 'complete');
  const critiqueRound = phase.rounds.find((round) => holds(round, 'CRITIC'));

  /** The newest finished draft, read and smoke-run. An unreadable reply is its own failure. */
  const assess = async (): Promise<{ method: Method | null; report: string; ok: boolean }> => {
    const round = finished.at(-1);
    const turn = round ? turnsOf(snapshot.events, round.roundId).at(-1) : undefined;
    if (!turn) return { method: null, report: 'No method was written.', ok: false };
    let method: Method;
    try {
      method = parseMethod(turn.text, turn.participantId, turn.messageId);
    } catch (error) {
      if (!(error instanceof ModelOutputError)) throw error;
      return { method: null, report: `The reply could not be read: ${error.message}`, ok: false };
    }
    const run = await tools.ports.execute(snapshot.sessionId, {
      code: method.code,
      seed: method.seed,
      timeoutMs: SMOKE_TIMEOUT_MS,
    });
    return { method, report: describeRun(run), ok: runnable(run) };
  };

  const critiques = (): MethodCritique[] =>
    critiqueRound === undefined
      ? []
      : turnsOf(snapshot.events, critiqueRound.roundId).flatMap((turn) => {
          try {
            return parseJsonReply(turn.text, methodCritiquesSchema, turn.participantId).critiques;
          } catch (error) {
            // A critic that answered in prose loses its say; the turn is still in the log.
            if (error instanceof ModelOutputError) return [];
            throw error;
          }
        });

  if (open) {
    if (open === critiqueRound) {
      const { method, report } = await assess();
      if (!method) throw new Error('the critique round opened with no method to critique');
      await tools.runBlindRound(snapshot, phase, open, () =>
        methodCritiquePrompt(charter, hypotheses, method, report),
      );
      await tools.closeRound(snapshot, state, phase, open);
      return;
    }

    // A draft or a revision. A revision is written against the previous
    // draft's smoke run and everything the critics said about it.
    const previous = finished.length === 0 ? null : await assess();
    const prompt = methodPrompt(
      charter,
      hypotheses,
      previous === null
        ? undefined
        : { previous: previous.method, report: previous.report, critiques: critiques() },
    );
    await tools.runTurn(snapshot, phase, open, holderOf(open, 'PROPOSER'), 'PROPOSER', prompt);
    await tools.closeRound(snapshot, state, phase, open);
    return;
  }

  const first = drafts[0];
  if (!first) {
    await tools.openRound(snapshot, state, phase, {
      index: 0,
      mode: 'SEQUENTIAL',
      demands: [{ role: 'PROPOSER', count: 1 }],
    });
    return;
  }

  const author = holderOf(first, 'PROPOSER');
  const assessed = await assess();
  const revise = async (): Promise<void> => {
    if (drafts.length >= MAX_METHOD_DRAFTS) {
      throw new Error(
        `no runnable method after ${String(drafts.length)} drafts. ${assessed.report}`,
      );
    }
    await tools.openRound(snapshot, state, phase, {
      index: phase.rounds.length,
      mode: 'SEQUENTIAL',
      // The author revises its own method; rotation does not get a say.
      fixed: [{ participantId: author, role: 'PROPOSER' }],
    });
  };

  if (critiqueRound === undefined) {
    // Nothing readable to critique yet: have the author try again first.
    if (assessed.method === null) return await revise();

    // Every model from another vendor, at once and unseen by each other. With
    // no such model the solver refuses and the phase fails loudly: a method
    // nobody else looked at has not been critiqued (P1).
    const authorVendor = snapshot.roster.find((entry) => entry.participantId === author)?.model
      .vendorId;
    const eligible = snapshot.roster.filter(
      (entry) => entry.weight > 0 && entry.model.vendorId !== authorVendor,
    );
    await tools.openRound(snapshot, state, phase, {
      index: phase.rounds.length,
      mode: 'BLIND_PARALLEL',
      demands: [{ role: 'CRITIC', count: Math.max(1, eligible.length) }],
      authors: [author],
    });
    return;
  }

  const raised = critiques().length;
  const revisedSince = phase.rounds
    .slice(phase.rounds.indexOf(critiqueRound) + 1)
    .some((round) => holds(round, 'PROPOSER'));
  // Critiques are answered at least once, even when the first draft ran.
  if (!assessed.ok || (raised > 0 && !revisedSince)) return await revise();

  await tools.closePhase(
    snapshot.sessionId,
    state,
    phase,
    'complete',
    `a method critiqued blind on ${String(raised)} point(s) across ${String(
      METHOD_AXES.length,
    )} axes, in its draft number ${String(drafts.length)}. ${assessed.report}`,
  );
};

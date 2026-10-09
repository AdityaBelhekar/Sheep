import { domainEvent, type DomainEvent } from '@sheep/core';
import { describeRun, finalMethod } from './method';
import { findingsPrompt, findingsSchema, ModelOutputError, parseJsonReply } from './prompts';
import { charterOf, completedPhase, hypothesesOf, turnsOf } from './reading';
import type { PhaseBody } from './tools';

/**
 * EXECUTION: the method is run, and only what the run produced may be claimed.
 *
 * The script METHOD settled on is run in the sandbox in full. Its author is
 * then shown the output and asked what it found — and this is where "no
 * unearned results" stops being a rule in a prompt and becomes something the
 * engine does:
 *
 * - The author is never asked if the run failed. A run that did not finish
 *   cleanly yields no findings, because there is nothing to read them from.
 * - Each empirical finding is recorded with the execution attached by the
 *   engine. The model does not get to say which run backs its claim.
 * - A finding that quotes a figure appearing nowhere in the run's output is
 *   refused. A number that was not printed was not measured.
 * - The ledger then checks every one again on the way into the log.
 */

/** The full run's wall clock. Under the RPC timeout, so a slow run is reported as slow. */
export const RUN_TIMEOUT_MS = 300_000;

/**
 * Decimals and percentages: the form a measurement takes. Bare integers are
 * left alone — "3 runs" and "128k tokens" are not results.
 */
const QUOTED = /(?<![\d.])-?\d+\.\d+(?:[eE][-+]?\d+)?%?|(?<![\d.])-?\d+%/g;
const PRINTED = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

/**
 * The figures a statement quotes that appear nowhere in `source`.
 *
 * Matched as numbers, to the precision the statement used: output of 0.3127
 * earns a claim of 0.31, and a claim of 93.2% is earned by 0.932. Returned as
 * written, so the refusal can name them.
 */
export function unearnedNumbers(statement: string, source: string): string[] {
  const printed = (source.match(PRINTED) ?? []).map(Number);
  return (statement.match(QUOTED) ?? []).filter((token) => {
    const percent = token.endsWith('%');
    const [mantissa = '', exponent = '0'] = (percent ? token.slice(0, -1) : token).split(/[eE]/);
    const value = Number(`${mantissa}e${exponent}`);
    const decimals = (mantissa.split('.')[1] ?? '').length;
    const tolerance = 0.5 * 10 ** (Number(exponent) - decimals) * (1 + 1e-9);
    const earned = (target: number, slack: number): boolean =>
      printed.some((candidate) => Math.abs(candidate - target) <= slack);
    return !(earned(value, tolerance) || (percent && earned(value / 100, tolerance / 100)));
  });
}

export const stepExecution: PhaseBody = async ({ tools, snapshot, state, phase }) => {
  const method = finalMethod(snapshot, completedPhase(state, 'METHOD'));
  const hypotheses = hypothesesOf(snapshot, state);

  // Asked for on every step and run once: a clean run of this code with this
  // seed is returned again, including the one METHOD's smoke run completed.
  const run = await tools.ports.execute(snapshot.sessionId, {
    code: method.code,
    seed: method.seed,
    timeoutMs: RUN_TIMEOUT_MS,
  });
  if (run.execution.status !== 'ok') {
    throw new Error(
      `the method's run did not finish cleanly, so nothing can be claimed from it. ${describeRun(run)}`,
    );
  }

  const round = phase.rounds[0];
  if (!round) {
    await tools.openRound(snapshot, state, phase, {
      index: 0,
      mode: 'SEQUENTIAL',
      // Whoever wrote the method reads its output; critics come next phase.
      fixed: [{ participantId: method.authorId, role: 'PROPOSER' }],
    });
    return;
  }

  if (round.status === 'open') {
    await tools.runTurn(
      snapshot,
      phase,
      round,
      method.authorId,
      'PROPOSER',
      findingsPrompt(charterOf(snapshot), hypotheses, method, run),
    );
    await tools.closeRound(snapshot, state, phase, round);
    return;
  }

  const turn = turnsOf(snapshot.events, round.roundId).at(-1);
  const claims: DomainEvent[] = [];
  const refused: string[] = [];
  let unreadable: string | null = null;

  if (turn) {
    try {
      // What a claim may legitimately quote: what was printed, and the
      // thresholds and constants the method itself stated in advance.
      const quotable = [
        run.stdout,
        method.plan,
        method.analysis,
        method.code,
        ...hypotheses.map((entry) => entry.claim.statement),
      ].join('\n');

      for (const finding of parseJsonReply(turn.text, findingsSchema, turn.participantId)
        .findings) {
        const invented =
          finding.type === 'EMPIRICAL' ? unearnedNumbers(finding.statement, quotable) : [];
        if (invented.length > 0) {
          refused.push(
            `"${finding.statement}" quotes ${invented.join(', ')}, which the run never printed`,
          );
          continue;
        }
        claims.push(
          domainEvent('claim.recorded', {
            sessionId: snapshot.sessionId,
            claimId: tools.ports.newId(),
            claimType: finding.type,
            statement: finding.statement,
            phaseId: phase.phaseId,
            messageId: turn.messageId,
            authorParticipantId: turn.participantId,
            ...(finding.confidence === undefined ? {} : { confidence: finding.confidence }),
            // Attached here, by the engine: the claim rests on the run that
            // was just made and on no other.
            ...(finding.type === 'EMPIRICAL'
              ? { support: [{ kind: 'EXECUTION' as const, ref: run.execution.executionId }] }
              : {}),
          }),
        );
      }
    } catch (error) {
      if (!(error instanceof ModelOutputError)) throw error;
      unreadable = error.message;
    }
  }

  const parts = [
    `the method ran cleanly (execution ${run.execution.executionId.slice(0, 8)}) and ${String(claims.length)} finding(s) were recorded against it`,
    ...(unreadable === null ? [] : [`the findings could not be read: ${unreadable}`]),
    ...(refused.length === 0 ? [] : [`${String(refused.length)} refused: ${refused.join('; ')}`]),
  ];
  await tools.closePhase(snapshot.sessionId, state, phase, 'complete', parts.join('. '), claims);
};

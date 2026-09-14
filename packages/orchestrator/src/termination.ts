import { meanPairwiseSimilarity, cosineSimilarity } from './similarity';

/**
 * When a phase stops.
 *
 * Four independent stops, checked in a fixed order, because an autonomous loop
 * with no exit is not a research tool — it is a way to spend money slowly:
 *
 * - **Budget.** Hard, and first: nothing else matters if the next round cannot
 *   be paid for. Raised by the governor, honoured here.
 * - **Round cap.** A ceiling, not a target. Hit means "this did not converge",
 *   which is a legitimate finding rather than a failure to report.
 * - **Convergence.** The roster is saying the same thing as each other. More
 *   rounds of agreement produce agreement, not evidence.
 * - **Loop.** This round said what the last round said. Distinct from
 *   convergence: models can repeat themselves while still disagreeing, and that
 *   is the case where another round is pure waste.
 *
 * The thresholds are lexical-similarity numbers and therefore approximate; they
 * are tuned to be reluctant, because stopping early costs a finding and
 * stopping late costs money.
 */

export const TERMINATION_REASONS = [
  'budget',
  'round-cap',
  'converged',
  'loop',
  'cancelled',
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

export interface TerminationRules {
  /** Rounds one phase may run before it stops regardless. */
  readonly maxRounds: number;
  /** Mean intra-round similarity above which the roster has converged. */
  readonly convergenceThreshold: number;
  /** Similarity to the previous round above which the phase is looping. */
  readonly loopThreshold: number;
  /** Consecutive looping rounds tolerated before stopping. */
  readonly loopPatience: number;
}

export const DEFAULT_TERMINATION_RULES: TerminationRules = {
  maxRounds: 6,
  convergenceThreshold: 0.85,
  loopThreshold: 0.92,
  loopPatience: 2,
};

export interface TerminationInput {
  /** Rounds already completed in this phase. */
  readonly roundsCompleted: number;
  /** Each completed round's turns, oldest round first. */
  readonly roundTexts: readonly (readonly string[])[];
  readonly budget: { readonly capUsd: number | null; readonly spentUsd: number };
  /** What the next round is expected to cost, when it can be estimated. */
  readonly nextRoundCostUsd?: number | null;
  readonly cancelled?: boolean;
  readonly rules?: Partial<TerminationRules>;
}

export interface TerminationVerdict {
  readonly stop: boolean;
  readonly reason: TerminationReason | null;
  readonly detail: string;
  /** The measurements behind the verdict, so a stop can be explained. */
  readonly metrics: {
    readonly agreement: number;
    readonly repetition: number;
    readonly consecutiveRepeats: number;
  };
}

export function shouldTerminate(input: TerminationInput): TerminationVerdict {
  const rules = { ...DEFAULT_TERMINATION_RULES, ...input.rules };
  const rounds = input.roundTexts;
  const last = rounds[rounds.length - 1] ?? [];

  const agreement = meanPairwiseSimilarity(last);
  const repetition = rounds.length < 2 ? 0 : roundSimilarity(rounds[rounds.length - 2] ?? [], last);
  const consecutiveRepeats = countRepeats(rounds, rules.loopThreshold);

  const metrics = { agreement, repetition, consecutiveRepeats };
  const verdict = (reason: TerminationReason, detail: string): TerminationVerdict => ({
    stop: true,
    reason,
    detail,
    metrics,
  });

  if (input.cancelled === true) return verdict('cancelled', 'the session was cancelled');

  if (input.budget.capUsd !== null) {
    const next = input.nextRoundCostUsd ?? 0;
    if (input.budget.spentUsd + next > input.budget.capUsd) {
      return verdict(
        'budget',
        `another round would take spend past the $${input.budget.capUsd.toFixed(2)} cap ` +
          `($${input.budget.spentUsd.toFixed(4)} spent)`,
      );
    }
  }

  if (input.roundsCompleted >= rules.maxRounds) {
    return verdict(
      'round-cap',
      `the ${String(rules.maxRounds)}-round cap was reached without convergence`,
    );
  }

  // Convergence and repetition only mean something once a phase has had more
  // than one round to say something with. A first round in which the models
  // happen to agree is agreement, not a finished argument — stopping there
  // would end most phases before they started.
  if (input.roundsCompleted < 1) {
    return { stop: false, reason: null, detail: 'the phase has not run a full round yet', metrics };
  }

  if (consecutiveRepeats >= rules.loopPatience) {
    return verdict(
      'loop',
      `the last ${String(consecutiveRepeats + 1)} rounds repeated each other ` +
        `(similarity ${repetition.toFixed(2)})`,
    );
  }

  if (last.length > 1 && agreement >= rules.convergenceThreshold) {
    return verdict('converged', `the roster agrees (mean similarity ${agreement.toFixed(2)})`);
  }

  return { stop: false, reason: null, detail: 'the phase may continue', metrics };
}

/** How much one round repeated the round before it. */
function roundSimilarity(previous: readonly string[], current: readonly string[]): number {
  if (previous.length === 0 || current.length === 0) return 0;
  return cosineSimilarity(previous.join('\n'), current.join('\n'));
}

/** Consecutive round pairs at the end of the phase that were near-identical. */
function countRepeats(rounds: readonly (readonly string[])[], threshold: number): number {
  let repeats = 0;
  for (let i = rounds.length - 1; i > 0; i -= 1) {
    if (roundSimilarity(rounds[i - 1] ?? [], rounds[i] ?? []) < threshold) break;
    repeats += 1;
  }
  return repeats;
}

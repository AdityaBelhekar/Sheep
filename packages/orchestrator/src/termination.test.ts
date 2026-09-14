import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINATION_RULES, shouldTerminate } from './termination';

describe('shouldTerminate', () => {
  const budget = { capUsd: null, spentUsd: 0 };

  it('lets an early, disagreeing phase continue', () => {
    const verdict = shouldTerminate({
      roundsCompleted: 1,
      roundTexts: [['sparse attention helps', 'the bundled runtime is pinned to 3.12']],
      budget,
    });
    expect(verdict.stop).toBe(false);
  });

  it('stops when another round would cross the budget cap', () => {
    const verdict = shouldTerminate({
      roundsCompleted: 1,
      roundTexts: [['anything']],
      budget: { capUsd: 1, spentUsd: 0.95 },
      nextRoundCostUsd: 0.2,
    });
    expect(verdict.reason).toBe('budget');
  });

  it('stops at the round cap', () => {
    const verdict = shouldTerminate({
      roundsCompleted: DEFAULT_TERMINATION_RULES.maxRounds,
      roundTexts: [['anything']],
      budget,
    });
    expect(verdict.reason).toBe('round-cap');
  });

  it('stops once the roster is saying the same thing as each other', () => {
    const agreed = 'Block-sparse attention preserves perplexity within two percent at 128k tokens';
    const verdict = shouldTerminate({
      roundsCompleted: 1,
      roundTexts: [[agreed, agreed, agreed]],
      budget,
    });
    expect(verdict.reason).toBe('converged');
    expect(verdict.metrics.agreement).toBeGreaterThan(0.9);
  });

  it('stops once rounds start repeating each other, even while they disagree', () => {
    const roundA = ['sparse attention is fine', 'sparse attention is not fine'];
    const verdict = shouldTerminate({
      roundsCompleted: 3,
      roundTexts: [roundA, [...roundA], [...roundA]],
      budget,
    });
    expect(verdict.reason).toBe('loop');
    expect(verdict.metrics.consecutiveRepeats).toBeGreaterThanOrEqual(2);
  });

  it('cancellation beats every other reason', () => {
    const verdict = shouldTerminate({
      roundsCompleted: 0,
      roundTexts: [],
      budget: { capUsd: 1, spentUsd: 99 },
      cancelled: true,
    });
    expect(verdict.reason).toBe('cancelled');
  });
});

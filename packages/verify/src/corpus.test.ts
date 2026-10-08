import { describe, expect, it } from 'vitest';
import { derivationSchema, type Derivation, type DerivationVerdict } from '@sheep/core';
import bad from '../corpus/bad.json';
import good from '../corpus/good.json';
import { derivation, testVerifier } from './test-support';

/**
 * The corpus: derivations whose right answer is known in advance.
 *
 * `good.json` holds derivations in which every step follows. `bad.json` holds
 * derivations with an error planted at a marked step — the mistakes people and
 * models actually make: a dropped factor, a rule used outside its domain, a
 * sign. A checker is only worth trusting if it passes the first set *and*
 * fails the second at exactly the marked steps. One that never fails
 * manufactures confidence, and this suite is what would notice.
 */

interface CorpusStep {
  statement: string;
  operation: string;
  from?: string;
  using?: string;
  args?: Record<string, string>;
  /** The verdict this step must get. PASS when absent. */
  expect?: string;
}

interface CorpusCase {
  name: string;
  /** What is wrong with it, for a known-bad derivation. */
  error?: string;
  symbols?: Derivation['symbols'];
  given: string[];
  steps: CorpusStep[];
}

const verifier = testVerifier();

const toDerivation = (entry: CorpusCase): Derivation =>
  derivationSchema.parse(
    derivation(
      entry.given,
      entry.steps.map(({ expect: _expected, ...step }) => step),
      entry.symbols,
    ),
  );

const expected = (entry: CorpusCase): string[] => entry.steps.map((step) => step.expect ?? 'PASS');

const describeVerdict = (verdict: DerivationVerdict): string =>
  verdict.steps.map((step) => `${step.id} ${step.status}: ${step.reason}`).join('\n');

describe('derivation corpus', async () => {
  const goodCases = good as CorpusCase[];
  const badCases = bad as CorpusCase[];
  // One interpreter for the whole corpus: each case is independent inside it.
  const verdicts = await verifier.checkDerivations([...goodCases, ...badCases].map(toDerivation));
  const goodVerdicts = verdicts.slice(0, goodCases.length);
  const badVerdicts = verdicts.slice(goodCases.length);

  it('is big enough to mean something, and every bad case plants an error', () => {
    expect(goodCases.length).toBeGreaterThanOrEqual(20);
    expect(badCases.length).toBeGreaterThanOrEqual(20);
    for (const entry of badCases) {
      expect(expected(entry), entry.name).toContain('FAIL');
      expect(entry.error, entry.name).toBeTruthy();
    }
    for (const entry of goodCases) {
      expect(new Set(expected(entry)), entry.name).toEqual(new Set(['PASS']));
    }
  });

  describe('known-good: every valid derivation passes', () => {
    it.each(goodCases.map((entry, index) => [entry.name, index] as const))('%s', (_name, index) => {
      const verdict = goodVerdicts[index]!;
      expect(
        verdict.steps.map((step) => step.status),
        describeVerdict(verdict),
      ).toEqual(expected(goodCases[index]!));
      expect(verdict.status).toBe('PASS');
      expect(verdict.given.every((premise) => premise.problem === null)).toBe(true);
    });
  });

  describe('known-bad: every planted error is caught, at the step it was planted', () => {
    it.each(badCases.map((entry, index) => [entry.name, index] as const))('%s', (_name, index) => {
      const verdict = badVerdicts[index]!;
      expect(
        verdict.steps.map((step) => step.status),
        describeVerdict(verdict),
      ).toEqual(expected(badCases[index]!));
      expect(verdict.status).toBe('FAIL');
    });
  });

  it('never lets a planted error through as a pass', () => {
    const missed = badCases.flatMap((entry, index) =>
      entry.steps.flatMap((step, at) =>
        step.expect === 'FAIL' && badVerdicts[index]!.steps[at]!.status === 'PASS'
          ? [`${entry.name}, step ${String(at + 1)}`]
          : [],
      ),
    );
    expect(missed).toEqual([]);
  });
});

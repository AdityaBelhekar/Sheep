import { describe, expect, it } from 'vitest';
import {
  statisticalReportSchema,
  type ReportedTest,
  type StatisticalAudit,
  type StatisticalReport,
} from '@sheep/core';
import { testVerifier } from './test-support';

const verifier = testVerifier();

/** A well-reported two-group comparison: 64 per group, d = 0.6. */
const SOUND: ReportedTest = {
  name: 'treatment vs control',
  test: 't',
  statistic: 3.394,
  df: 126,
  p: 0.0009,
  effect: { kind: 'd', value: 0.6 },
  ci: { level: 0.95, low: 0.25, high: 0.95 },
};

const report = (overrides: Partial<StatisticalReport> = {}): StatisticalReport =>
  statisticalReportSchema.parse({
    name: 'study',
    groups: [
      { name: 'treatment', n: 64 },
      { name: 'control', n: 64 },
    ],
    tests: [SOUND],
    ...overrides,
  });

const audit = async (...reports: StatisticalReport[]): Promise<StatisticalAudit[]> =>
  verifier.auditStatistics(reports);

/** `check: STATUS` for each finding, optionally for one check only. */
const statuses = (result: StatisticalAudit, check?: string): string[] =>
  result.findings
    .filter((finding) => check === undefined || finding.check === check)
    .map((finding) =>
      check === undefined ? `${finding.check}: ${finding.status}` : finding.status,
    );

const reasonFor = (result: StatisticalAudit, check: string): string =>
  result.findings.find((finding) => finding.check === check)!.reason;

describe('statistical audit', () => {
  it('finds nothing wrong with a sound, completely reported result', async () => {
    const [result] = await audit(report());

    expect(statuses(result!)).toEqual([
      'sample-size: PASS',
      'effect-size: PASS',
      'power: PASS',
      'confidence-interval: PASS',
      'p-value: PASS',
      'multiple-comparisons: PASS',
      // One p-value has no shape. Undecided, and the audit says so.
      'p-curve: UNCHECKABLE',
    ]);
    expect(result!.status).toBe('UNCHECKABLE');
    expect(reasonFor(result!, 'power')).toMatch(/detects d = 0.6 9\d% of the time/);
  });

  it('fails a result that reports a p-value and nothing else', async () => {
    const [result] = await audit(
      statisticalReportSchema.parse({ name: 'bare', tests: [{ name: 'effect', p: 0.03 }] }),
    );

    expect(statuses(result!)).toEqual([
      'sample-size: FAIL',
      'effect-size: FAIL',
      'power: UNCHECKABLE',
      'confidence-interval: FAIL',
      'p-value: UNCHECKABLE',
      'multiple-comparisons: PASS',
      'p-curve: UNCHECKABLE',
    ]);
    expect(result!.status).toBe('FAIL');
  });

  it('recomputes each p-value from its test statistic', async () => {
    const tests: ReportedTest[] = [
      { ...SOUND, name: 't, as reported' },
      // t(28) = 1.5 is p = .145, not .03.
      { ...SOUND, name: 't, misreported', statistic: 1.5, df: 28, p: 0.03 },
      { ...SOUND, name: 'one-tailed t', statistic: 1.8, df: 40, tails: 1, p: 0.0397 },
      { ...SOUND, name: 'z', test: 'z', statistic: 1.96, df: undefined, p: 0.05 },
      { ...SOUND, name: 'chi2', test: 'chi2', statistic: 3.84, df: 1, p: 0.05 },
      { ...SOUND, name: 'F', test: 'f', statistic: 4.0, df: 2, df2: 60, p: 0.0234 },
      { ...SOUND, name: 'r', test: 'r', statistic: 0.3, df: 98, p: 0.0024 },
      // Rounded the convenient way: .054 reported as .049.
      { ...SOUND, name: 'rounded across the line', statistic: 1.945, df: 126, p: 0.049 },
    ];
    const [result] = await audit(report({ tests, correction: 'holm' }));

    expect(statuses(result!, 'p-value')).toEqual([
      'PASS',
      'FAIL',
      'PASS',
      'PASS',
      'PASS',
      'PASS',
      'PASS',
      'FAIL',
    ]);
    const reasons = result!.findings.filter((finding) => finding.check === 'p-value');
    expect(reasons[1]!.reason).toMatch(/reported p = 0.03, but t\(28\) = 1.5 gives p = 0.145/);
    expect(reasons[7]!.reason).toMatch(/changes whether it is significant/);
  });

  it('checks an interval against its estimate and its p-value', async () => {
    const [outside, contradicts, upsideDown, ratio] = await audit(
      report({ tests: [{ ...SOUND, ci: { level: 0.95, low: 0.7, high: 0.9 } }] }),
      // Significant, yet the interval contains zero.
      report({ tests: [{ ...SOUND, ci: { level: 0.95, low: -0.1, high: 1.3 } }] }),
      report({ tests: [{ ...SOUND, ci: { level: 0.95, low: 0.95, high: 0.25 } }] }),
      // For a ratio, "no effect" is 1, and this interval excludes it.
      report({
        tests: [
          {
            ...SOUND,
            effect: { kind: 'odds-ratio', value: 1.8 },
            ci: { level: 0.95, low: 1.2, high: 2.7, null: 1 },
          },
        ],
      }),
    );

    expect(reasonFor(outside!, 'confidence-interval')).toMatch(/lies outside its own interval/);
    expect(reasonFor(contradicts!, 'confidence-interval')).toMatch(
      /contains 0, which contradicts p = 0.0009/,
    );
    expect(reasonFor(upsideDown!, 'confidence-interval')).toMatch(/upside down/);
    expect(statuses(ratio!, 'confidence-interval')).toEqual(['PASS']);
    for (const result of [outside, contradicts, upsideDown]) {
      expect(statuses(result!, 'confidence-interval')).toEqual(['FAIL']);
    }
  });

  it('fails a significant result from a design too small to find it', async () => {
    const tiny = [
      { name: 'treatment', n: 8 },
      { name: 'control', n: 8 },
    ];
    const [result] = await audit(
      report({
        groups: tiny,
        tests: [{ ...SOUND, statistic: 2.2, df: 14, p: 0.045, effect: { kind: 'd', value: 0.4 } }],
      }),
    );

    expect(statuses(result!, 'power')).toEqual(['FAIL']);
    expect(reasonFor(result!, 'power')).toMatch(/detects d = 0.4 1\d% of the time/);
  });

  it('corrects for the comparisons that were run, including the unreported ones', async () => {
    const tests = [0.004, 0.02, 0.03, 0.04].map((p, index): ReportedTest => ({
      name: `outcome ${String(index + 1)}`,
      p,
    }));
    const [uncorrected, corrected, hidden, lenient, single] = await audit(
      report({ tests }),
      report({ tests, correction: 'bonferroni' }),
      // Four reported, twenty run: nothing survives.
      report({ tests, comparisons: 20, correction: 'holm' }),
      report({ tests, correction: 'benjamini-hochberg' }),
      report({ tests: [tests[0]!, { name: 'second', p: 0.01 }] }),
    );

    expect(statuses(uncorrected!, 'multiple-comparisons')).toEqual(['FAIL']);
    expect(reasonFor(uncorrected!, 'multiple-comparisons')).toMatch(
      /4 comparisons, and no correction was applied; under Holm these are no longer significant: outcome 2 .*outcome 3 .*outcome 4/,
    );
    expect(reasonFor(corrected!, 'multiple-comparisons')).toMatch(/under bonferroni/);
    expect(reasonFor(hidden!, 'multiple-comparisons')).toMatch(/20 comparisons.*outcome 1 /);
    // Benjamini-Hochberg controls a weaker error rate, and all four survive it.
    expect(statuses(lenient!, 'multiple-comparisons')).toEqual(['PASS']);
    expect(reasonFor(single!, 'multiple-comparisons')).toMatch(/every significant result survives/);
  });

  it('tells findings from searching by the shape of the p-values', async () => {
    const tests = (values: number[]): ReportedTest[] =>
      values.map((p, index) => ({ name: `test ${String(index + 1)}`, p }));
    const [hacked, genuine, few] = await audit(
      // Every one of them just under the line.
      report({ tests: tests([0.041, 0.048, 0.044, 0.039, 0.049, 0.046, 0.043, 0.047]) }),
      // What a real effect looks like: mostly far below it.
      report({ tests: tests([0.001, 0.0004, 0.003, 0.012, 0.0001, 0.02, 0.006, 0.041]) }),
      report({ tests: tests([0.04, 0.045, 0.049]) }),
    );

    expect(statuses(hacked!, 'p-curve')).toEqual(['FAIL']);
    expect(reasonFor(hacked!, 'p-curve')).toMatch(
      /8 of 8 significant p-values fall in the half nearest alpha/,
    );
    expect(statuses(genuine!, 'p-curve')).toEqual(['PASS']);
    expect(statuses(few!, 'p-curve')).toEqual(['UNCHECKABLE']);
  });

  it('honours a stated alpha', async () => {
    const tests: ReportedTest[] = [{ ...SOUND, statistic: 2.3, df: 126, p: 0.023 }];
    const [strict] = await audit(
      report({
        alpha: 0.01,
        tests: [{ ...tests[0]!, ci: { level: 0.99, low: -0.05, high: 0.9 } }],
      }),
    );

    // Not significant at .01, and the 99% interval rightly contains zero.
    expect(statuses(strict!, 'confidence-interval')).toEqual(['PASS']);
  });
});

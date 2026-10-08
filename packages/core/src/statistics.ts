import { z } from 'zod';
import { verificationStatusSchema } from './derivation';

/**
 * What an empirical claim reports about its statistics, in a form a program
 * can audit.
 *
 * The audit does not judge whether the claim is true. It asks whether the
 * numbers offered in support of it are complete, agree with each other, and
 * mean what they are presented as meaning: is there a sample size, an effect
 * size and an interval; does the test statistic give the p-value reported;
 * do the results survive correction for how many tests were run; and are the
 * significant p-values shaped like findings or like searching.
 */

const probabilitySchema = z.number().min(0).max(1);

export const STATISTICAL_TESTS = ['t', 'z', 'chi2', 'f', 'r'] as const;
export const P_CORRECTIONS = ['none', 'bonferroni', 'holm', 'benjamini-hochberg'] as const;

export const reportedTestSchema = z.strictObject({
  name: z.string().min(1).max(200),
  /** The kind of test, with the statistic and degrees of freedom it reported. */
  test: z.enum(STATISTICAL_TESTS).optional(),
  statistic: z.number().optional(),
  df: z.number().positive().optional(),
  /** Denominator degrees of freedom, for an F test. */
  df2: z.number().positive().optional(),
  /** One- or two-tailed. Two when absent. */
  tails: z.union([z.literal(1), z.literal(2)]).optional(),
  /** The p-value as reported, uncorrected. */
  p: probabilitySchema.optional(),
  /** `d` is a standardised mean difference; any other kind is recorded, not interpreted. */
  effect: z.strictObject({ kind: z.string().min(1).max(40), value: z.number() }).optional(),
  ci: z
    .strictObject({
      level: probabilitySchema,
      low: z.number(),
      high: z.number(),
      /** The value meaning "no effect": 0 for a difference, 1 for a ratio. 0 when absent. */
      null: z.number().optional(),
    })
    .optional(),
});
export type ReportedTest = z.infer<typeof reportedTestSchema>;

export const statisticalReportSchema = z.strictObject({
  name: z.string().min(1).max(200),
  /** The significance threshold. 0.05 when absent. */
  alpha: z.number().gt(0).lt(1).optional(),
  /** Total observations, when there are no groups to list. */
  n: z.number().int().positive().optional(),
  groups: z
    .array(z.strictObject({ name: z.string().min(1).max(200), n: z.number().int().positive() }))
    .optional(),
  tests: z.array(reportedTestSchema).min(1).max(500),
  /** Every comparison that was run, including the ones not reported. */
  comparisons: z.number().int().positive().optional(),
  correction: z.enum(P_CORRECTIONS).optional(),
});
export type StatisticalReport = z.infer<typeof statisticalReportSchema>;

export const statisticalFindingSchema = z.strictObject({
  /** `sample-size`, `effect-size`, `power`, `confidence-interval`, `p-value`, `multiple-comparisons`, `p-curve`. */
  check: z.string(),
  /** The test it is about; null for a finding about the report as a whole. */
  subject: z.string().nullable(),
  status: verificationStatusSchema,
  reason: z.string(),
});
export type StatisticalFinding = z.infer<typeof statisticalFindingSchema>;

export const statisticalAuditSchema = z.strictObject({
  name: z.string(),
  /** `FAIL` if any check fails; otherwise `UNCHECKABLE` if any could not be made; otherwise `PASS`. */
  status: verificationStatusSchema,
  findings: z.array(statisticalFindingSchema),
});
export type StatisticalAudit = z.infer<typeof statisticalAuditSchema>;

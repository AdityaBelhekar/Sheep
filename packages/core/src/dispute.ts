import { z } from 'zod';
import { evidenceRefSchema } from './claim';
import { constraintClaimSchema, derivationSchema, verificationStatusSchema } from './derivation';
import { idSchema, proseSchema, timestampSchema } from './primitives';
import { positionSchema } from './protocol';
import { statisticalReportSchema } from './statistics';

/**
 * The fixed axes a critique must attack along.
 *
 * Fixed rather than free-text so that critiques are comparable across models
 * and rounds, and so a `proposedTest` can be routed automatically (Phase 52) —
 * a `DERIVATION` complaint goes to SymPy, a `POWER` complaint goes to the
 * statistical audit.
 */
export const CRITIQUE_AXES = [
  'INTERNAL_VALIDITY',
  'CONFOUNDS',
  'LEAKAGE',
  'POWER',
  'BASELINES',
  'REPRODUCIBILITY',
  'DERIVATION',
  'UNITS',
  'STATISTICS',
  'SCOPE',
  'NOVELTY',
] as const;
export const critiqueAxisSchema = z.enum(CRITIQUE_AXES);
export type CritiqueAxis = z.infer<typeof critiqueAxisSchema>;

export const DISPUTE_SEVERITIES = ['blocking', 'major', 'minor'] as const;
export const disputeSeveritySchema = z.enum(DISPUTE_SEVERITIES);
export type DisputeSeverity = z.infer<typeof disputeSeveritySchema>;

export const DISPUTE_STATUSES = ['open', 'resolved', 'unresolved', 'withdrawn'] as const;
export const disputeStatusSchema = z.enum(DISPUTE_STATUSES);
export type DisputeStatus = z.infer<typeof disputeStatusSchema>;

/**
 * How a dispute ended.
 *
 * `UNRESOLVED` is a first-class outcome, not a failure state: under P6 a
 * disagreement with no discriminating test ships in the paper as an Open
 * Question with both positions intact.
 */
export const DISPUTE_OUTCOMES = ['UPHELD', 'OVERTURNED', 'UNRESOLVED'] as const;
export const disputeOutcomeSchema = z.enum(DISPUTE_OUTCOMES);
export type DisputeOutcome = z.infer<typeof disputeOutcomeSchema>;

export const TEST_ROUTES = [
  'SANDBOX',
  'SYMBOLIC',
  'NUMERIC',
  'SMT',
  'STATISTICAL',
  'MANUAL',
] as const;

/**
 * A test a critic proposes as the thing that would settle the question.
 *
 * The description is for people. What makes a test routable is the payload
 * beside it — a script, a derivation, a constraint, a statistical report —
 * which a checker can be handed as it stands. A test with no payload its route
 * can run is a description of a test, and the dispute it belongs to stays open.
 */
export const proposedTestSchema = z.strictObject({
  /** Where this test can actually be decided. */
  route: z.enum(TEST_ROUTES),
  description: proseSchema,
  /** What outcome the critic says would falsify the claim. */
  falsifies: proseSchema.optional(),
  /**
   * Which result of the test falsifies the claim. `FAIL` when absent: the test
   * is something the claim should pass if it is true.
   */
  claimFailsIf: z.enum(['PASS', 'FAIL']).optional(),
  /**
   * For `SANDBOX` and `NUMERIC`: a script whose last printed line is
   * `SHEEP_TEST: PASS` or `SHEEP_TEST: FAIL`.
   */
  code: z.string().min(1).max(200_000).optional(),
  /** For `SYMBOLIC`: passes when every step follows. */
  derivation: derivationSchema.optional(),
  /** For `SMT`: passes when the claim holds in every case the assumptions allow. */
  constraint: constraintClaimSchema.optional(),
  /** For `STATISTICAL`: passes when the audit finds nothing wrong. */
  statistics: statisticalReportSchema.optional(),
});
export type ProposedTest = z.infer<typeof proposedTestSchema>;

/**
 * What happened when a dispute's test was run.
 *
 * `verdict` is the checker's: the test passed, failed, or could not be
 * decided. `outcome` is what that means for the dispute, given which result
 * the critic said would falsify the claim. No model contributes to either.
 */
export const disputeTestFields = {
  route: z.enum(TEST_ROUTES),
  verdict: verificationStatusSchema,
  outcome: disputeOutcomeSchema,
  /** The checker's own account: what it ran and what it found. */
  detail: proseSchema,
} as const;

export const disputeTestSchema = z.strictObject({
  ...disputeTestFields,
  /** The run or the stored verdict behind it; null when the test never ran. */
  evidence: evidenceRefSchema.nullable(),
});
export type DisputeTest = z.infer<typeof disputeTestSchema>;

export const disputeSchema = z.strictObject({
  disputeId: idSchema,
  sessionId: idSchema,
  claimId: idSchema,
  /** The participant raising it; null when a human did. */
  raisedByParticipantId: idSchema.nullable(),
  axis: critiqueAxisSchema,
  severity: disputeSeveritySchema,
  argument: proseSchema,
  proposedTest: proposedTestSchema.nullable(),
  /** The result of running that test; null until it has been, or if it cannot be. */
  test: disputeTestSchema.nullable(),
  status: disputeStatusSchema,
  openedAt: timestampSchema,
  resolvedAt: timestampSchema.nullable(),
});
export type Dispute = z.infer<typeof disputeSchema>;

/**
 * The record of a settled — or deliberately unsettled — dispute.
 *
 * The referee writes `rationale`, but `evidence` is what decides: a resolution
 * with no discriminating evidence, or one that contradicts the result of the
 * dispute's own test, is refused by the ledger.
 */
export const resolutionSchema = z.strictObject({
  disputeId: idSchema,
  outcome: disputeOutcomeSchema,
  rationale: proseSchema,
  evidence: z.array(evidenceRefSchema),
  /** The referee, when a model refereed. */
  resolvedByParticipantId: idSchema.nullable(),
  /** Preserved verbatim when the outcome is `UNRESOLVED`. */
  positions: z.array(positionSchema),
  resolvedAt: timestampSchema,
});
export type Resolution = z.infer<typeof resolutionSchema>;

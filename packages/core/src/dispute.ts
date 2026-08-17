import { z } from 'zod';
import { evidenceRefSchema } from './claim';
import { idSchema, proseSchema, timestampSchema } from './primitives';
import { positionSchema } from './protocol';

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

/** A test a critic proposes as the thing that would settle the question. */
export const proposedTestSchema = z.strictObject({
  /** Where this test can actually be decided. */
  route: z.enum(['SANDBOX', 'SYMBOLIC', 'NUMERIC', 'SMT', 'STATISTICAL', 'MANUAL']),
  description: proseSchema,
  /** What outcome the critic says would falsify the claim. */
  falsifies: proseSchema.optional(),
});
export type ProposedTest = z.infer<typeof proposedTestSchema>;

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
  status: disputeStatusSchema,
  openedAt: timestampSchema,
  resolvedAt: timestampSchema.nullable(),
});
export type Dispute = z.infer<typeof disputeSchema>;

/**
 * The record of a settled — or deliberately unsettled — dispute.
 *
 * The referee writes `rationale`, but `evidence` is what decides: a resolution
 * that overturns a claim with no discriminating evidence is exactly what
 * Phase 53 refuses to accept.
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

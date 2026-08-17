import { z } from 'zod';
import { confidenceSchema, idSchema, proseSchema, timestampSchema } from './primitives';

/**
 * The seven phases of a Sheep session, in the order they run.
 *
 * FRAMING and HYPOTHESIS each end at a human approval gate; the rest run
 * unattended. RESOLUTION may leave disputes `UNRESOLVED` on purpose — under P6
 * disagreement is output, not failure.
 */
export const PHASE_KINDS = [
  'FRAMING',
  'HYPOTHESIS',
  'METHOD',
  'EXECUTION',
  'CRITIQUE',
  'RESOLUTION',
  'SYNTHESIS',
] as const;
export const phaseKindSchema = z.enum(PHASE_KINDS);
export type PhaseKind = z.infer<typeof phaseKindSchema>;

/**
 * The roles a participant can hold for one round.
 *
 * DEVIL is a standing adversary rather than a critic of any single claim, and
 * REFEREE writes rationale but cannot overrule evidence (P4). Role *assignment*
 * constraints — no self-critique, critic vendor ≠ author vendor, referee
 * unstaked — are solved in Phase 24; this is only the vocabulary.
 */
export const PARTICIPANT_ROLES = [
  'PROPOSER',
  'CRITIC',
  'VERIFIER',
  'REFEREE',
  'DEVIL',
  'SCRIBE',
] as const;
export const participantRoleSchema = z.enum(PARTICIPANT_ROLES);
export type ParticipantRole = z.infer<typeof participantRoleSchema>;

export const PHASE_STATUSES = [
  'pending',
  'running',
  'awaiting-approval',
  'complete',
  'skipped',
  'failed',
] as const;
export const phaseStatusSchema = z.enum(PHASE_STATUSES);
export type PhaseStatus = z.infer<typeof phaseStatusSchema>;

/** How a phase may end. `running` and `pending` are not outcomes. */
export const PHASE_OUTCOMES = ['complete', 'skipped', 'failed'] as const;
export const phaseOutcomeSchema = z.enum(PHASE_OUTCOMES);
export type PhaseOutcome = z.infer<typeof phaseOutcomeSchema>;

export const phaseSchema = z.strictObject({
  phaseId: idSchema,
  sessionId: idSchema,
  kind: phaseKindSchema,
  /** 0-based position in this session's phase sequence. */
  index: z.number().int().nonnegative(),
  status: phaseStatusSchema,
  openedAt: timestampSchema,
  closedAt: timestampSchema.nullable(),
});
export type Phase = z.infer<typeof phaseSchema>;

/**
 * How the models in a round see each other.
 *
 * `BLIND_PARALLEL` is the anti-groupthink mechanism (P3): isolated contexts,
 * commit-then-reveal, so no model's context contains another's output before
 * every answer is in. `SEQUENTIAL` lets each turn read the ones before it.
 * `COLLECTIVE` is a single shared thread.
 */
export const ROUND_MODES = ['BLIND_PARALLEL', 'SEQUENTIAL', 'COLLECTIVE'] as const;
export const roundModeSchema = z.enum(ROUND_MODES);
export type RoundMode = z.infer<typeof roundModeSchema>;

export const ROUND_STATUSES = ['open', 'complete', 'aborted'] as const;
export const roundStatusSchema = z.enum(ROUND_STATUSES);
export type RoundStatus = z.infer<typeof roundStatusSchema>;

export const ROUND_OUTCOMES = ['complete', 'aborted'] as const;
export const roundOutcomeSchema = z.enum(ROUND_OUTCOMES);
export type RoundOutcome = z.infer<typeof roundOutcomeSchema>;

export const roundSchema = z.strictObject({
  roundId: idSchema,
  phaseId: idSchema,
  sessionId: idSchema,
  /** 0-based position within its phase. */
  index: z.number().int().nonnegative(),
  mode: roundModeSchema,
  status: roundStatusSchema,
  openedAt: timestampSchema,
  closedAt: timestampSchema.nullable(),
});
export type Round = z.infer<typeof roundSchema>;

/** One participant's role for one round. */
export const roleAssignmentSchema = z.strictObject({
  participantId: idSchema,
  role: participantRoleSchema,
});
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;

/**
 * A participant's pre-reveal commitment on a claim.
 *
 * Locked before anyone sees anyone else's position, so that movement afterwards
 * is measurable rather than deniable (Phase 32).
 */
export const STANCES = ['SUPPORT', 'OPPOSE', 'ABSTAIN'] as const;
export const stanceSchema = z.enum(STANCES);
export type Stance = z.infer<typeof stanceSchema>;

export const positionSchema = z.strictObject({
  participantId: idSchema,
  stance: stanceSchema,
  confidence: confidenceSchema,
  rationale: proseSchema.optional(),
});
export type Position = z.infer<typeof positionSchema>;

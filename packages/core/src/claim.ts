import { z } from 'zod';
import { confidenceSchema, idSchema, proseSchema, timestampSchema } from './primitives';

/**
 * How a claim earns the right to be believed (P2).
 *
 * - `DERIVED` — follows from stated premises by checkable steps.
 * - `EMPIRICAL` — rests on a recorded execution the sandbox actually ran.
 * - `CITED` — rests on external literature; may *support* a conclusion but
 *   never establish one alone.
 * - `CONJECTURE` — honestly unbacked, and labelled as such rather than smuggled
 *   in as a finding.
 *
 * Enforcement lives in Phase 31; this is the vocabulary it enforces over.
 */
export const CLAIM_TYPES = ['DERIVED', 'EMPIRICAL', 'CITED', 'CONJECTURE'] as const;
export const claimTypeSchema = z.enum(CLAIM_TYPES);
export type ClaimType = z.infer<typeof claimTypeSchema>;

export const CLAIM_STATUSES = [
  'asserted',
  'supported',
  'disputed',
  'refuted',
  'unresolved',
  'withdrawn',
] as const;
export const claimStatusSchema = z.enum(CLAIM_STATUSES);
export type ClaimStatus = z.infer<typeof claimStatusSchema>;

/**
 * What a piece of evidence *is*, so the ledger can tell backing apart from
 * assertion.
 *
 * `ARGUMENT` exists to be visibly weak: it records that the only support
 * offered was prose, which is precisely the case P2 refuses to let pass as
 * empirical backing.
 */
export const EVIDENCE_KINDS = [
  'EXECUTION',
  'DERIVATION',
  'CITATION',
  'ARTIFACT',
  'ARGUMENT',
] as const;
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

/**
 * A pointer from a claim to the record that backs it.
 *
 * `ref` is an id in the table implied by `kind` — an execution record, a
 * derivation, a retrieval record, a CAS artifact. Kept as a plain string so
 * `@sheep/core` stays free of any storage knowledge.
 */
export const evidenceRefSchema = z.strictObject({
  kind: evidenceKindSchema,
  ref: z.string().min(1).max(200),
  note: proseSchema.optional(),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

/** Claim kinds that cannot, on their own, establish a conclusion. */
export const NON_ESTABLISHING_CLAIM_TYPES = ['CITED', 'CONJECTURE'] as const;

export function canEstablishAlone(type: ClaimType): boolean {
  return !(NON_ESTABLISHING_CLAIM_TYPES as readonly string[]).includes(type);
}

/** The evidence kind a claim type must be able to point at to be supported. */
export const REQUIRED_EVIDENCE_KIND: Readonly<Record<ClaimType, EvidenceKind | null>> = {
  DERIVED: 'DERIVATION',
  EMPIRICAL: 'EXECUTION',
  CITED: 'CITATION',
  CONJECTURE: null,
};

export const claimSchema = z.strictObject({
  claimId: idSchema,
  sessionId: idSchema,
  /** The phase that produced it, if it came out of the protocol. */
  phaseId: idSchema.nullable(),
  /** The participant that asserted it; null when a human wrote it. */
  authorParticipantId: idSchema.nullable(),
  claimType: claimTypeSchema,
  /** One falsifiable sentence. Long prose belongs in a message, not a claim. */
  statement: z.string().min(1).max(2_000),
  status: claimStatusSchema,
  confidence: confidenceSchema.nullable(),
  support: z.array(evidenceRefSchema),
  recordedAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Claim = z.infer<typeof claimSchema>;

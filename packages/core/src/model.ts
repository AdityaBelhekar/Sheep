import { z } from 'zod';
import { idSchema, slugSchema, timestampSchema, usdSchema } from './primitives';

/**
 * Which company's weights are answering.
 *
 * A slug rather than an enum: Stage 2 adds adapters, and a new provider must not
 * require a change to the domain vocabulary. It is deliberately *not* the same
 * thing as a connection — two connections can point at the same vendor, and the
 * vendor is what P1 cares about, because a critique is only independent if it
 * comes from different weights than the claim it attacks.
 */
export const vendorIdSchema = slugSchema;
export type VendorId = z.infer<typeof vendorIdSchema>;

/**
 * A model as the provider names it: `claude-opus-5`, `gpt-5`, `llama3.1:8b`.
 * Not a slug — vendors use colons, slashes and dots.
 */
export const modelIdSchema = z.string().min(1).max(200);

/**
 * Exactly which model produced something, captured at the moment it did.
 *
 * `version` is separate from `modelId` because providers move an alias like
 * `claude-opus-5` onto new weights; provenance needs whatever the response
 * actually reported.
 *
 * Every field here is provenance, and there is deliberately no display label:
 * a name the user can rename has no business inside an immutable event, where
 * it would freeze at whatever it happened to be. The UI joins the connection
 * record for a label.
 */
export const modelRefSchema = z.strictObject({
  /** The stored connection this model was reached through. */
  connectionId: idSchema,
  vendorId: vendorIdSchema,
  modelId: modelIdSchema,
  version: z.string().min(1).max(200).optional(),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

/**
 * A model attached to a session: the unit roles are assigned to.
 *
 * The same model may join twice (two participants, one vendor) — role
 * assignment constrains on `vendorId`, never on participant identity.
 */
export const rosterEntrySchema = z.strictObject({
  participantId: idSchema,
  sessionId: idSchema,
  model: modelRefSchema,
  /** Relative say in collective steps. 1 is neutral; 0 makes an observer. */
  weight: z.number().min(0).max(10),
  /** Optional per-model spend ceiling, independent of the session cap. */
  budgetCapUsd: usdSchema.optional(),
  attachedAt: timestampSchema,
  detachedAt: timestampSchema.nullable(),
});
export type RosterEntry = z.infer<typeof rosterEntrySchema>;

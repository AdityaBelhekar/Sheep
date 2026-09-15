import { z } from 'zod';
import { modelRefSchema } from './model';
import {
  byteCountSchema,
  idSchema,
  sha256Schema,
  timestampSchema,
  tokenCountSchema,
  usdSchema,
} from './primitives';
import { participantRoleSchema } from './protocol';

/**
 * Who produced a message.
 *
 * A model author carries its own `ModelRef` snapshot rather than only a
 * participant id: the roster can be edited, and provenance must survive that.
 * `SYSTEM` is Sheep itself — prompt scaffolding, phase announcements — and is
 * never attributed to a vendor.
 */
export const messageAuthorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('MODEL'),
    participantId: idSchema,
    model: modelRefSchema,
  }),
  z.strictObject({ kind: z.literal('HUMAN') }),
  z.strictObject({ kind: z.literal('SYSTEM') }),
]);
export type MessageAuthor = z.infer<typeof messageAuthorSchema>;

/**
 * Message content, inline or by reference.
 *
 * Short turns live in the row; anything long is a content-addressed blob
 * (Phase 7), so the event log stays small and identical content is stored once.
 * `bytes` is carried alongside the hash so a UI can show a size without
 * touching the object store.
 */
export const messageBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    text: z.string().max(65_536),
  }),
  z.strictObject({
    kind: z.literal('blob'),
    hash: sha256Schema,
    bytes: byteCountSchema,
    mediaType: z.string().min(1).max(120),
  }),
]);
export type MessageBody = z.infer<typeof messageBodySchema>;

/**
 * How a turn stopped.
 *
 * The first six mirror the gateway's stop reasons; `error` is the seventh, and
 * is why this list lives here rather than being imported. A stream that dies
 * halfway still produced text, and that text is still recorded — so the record
 * needs a way to say "this is what survived", which a vendor's own vocabulary
 * has no word for. Null means the message did not come from a model at all.
 */
export const MESSAGE_FINISH_REASONS = [
  'stop',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'content_filter',
  'cancelled',
  'error',
] as const;
export const messageFinishReasonSchema = z.enum(MESSAGE_FINISH_REASONS);
export type MessageFinishReason = z.infer<typeof messageFinishReasonSchema>;

/** What one model call actually cost. Populated by the gateway (Phase 17). */
export const usageSchema = z.strictObject({
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  /** Cache reads are usually billed differently; kept separate, never summed in. */
  cachedInputTokens: tokenCountSchema.optional(),
  costUsd: usdSchema,
});
export type Usage = z.infer<typeof usageSchema>;

/**
 * The generation parameters a model call was sent with (Phase 35).
 *
 * Only what Sheep actually sets: the output cap, and a temperature when one is
 * given. Absent means the provider's default was used, which is itself worth
 * knowing when reproducing a run.
 */
export const generationParamsSchema = z.strictObject({
  maxOutputTokens: tokenCountSchema,
  temperature: z.number().min(0).max(2).optional(),
});
export type GenerationParams = z.infer<typeof generationParamsSchema>;

/**
 * One turn of the conversation.
 *
 * `phaseId` and `roundId` are nullable because not every message belongs to the
 * protocol — a user's aside, or an app notice, has no round.
 */
export const messageSchema = z.strictObject({
  messageId: idSchema,
  sessionId: idSchema,
  phaseId: idSchema.nullable(),
  roundId: idSchema.nullable(),
  author: messageAuthorSchema,
  /** The role the author held when it spoke, if it held one. */
  role: participantRoleSchema.nullable(),
  body: messageBodySchema,
  usage: usageSchema.nullable(),
  /** How the turn stopped. Null for anything a model did not produce. */
  finish: messageFinishReasonSchema.nullable(),
  /** What the call was sent with. Null for anything a model did not produce. */
  params: generationParamsSchema.nullable(),
  /** Hash of the exact prompt that produced this, for reproducibility (P5). */
  promptHash: sha256Schema.nullable(),
  recordedAt: timestampSchema,
});
export type Message = z.infer<typeof messageSchema>;

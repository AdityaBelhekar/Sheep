import { idSchema, modelIdSchema, tokenCountSchema } from '@sheep/core';
import { z } from 'zod';
import type { ModelCapability, ModelDescriptor } from './descriptor';

/**
 * The vendor-neutral shape of a model call.
 *
 * Every adapter translates *into* its provider's wire format from here, and
 * never the reverse: one canonical request means a Sheep session can be
 * replayed against a different vendor (P5), and means the orchestrator has
 * exactly one thing to build.
 */

/** A tool call the assistant made in an earlier turn. */
export const toolUsePartSchema = z.strictObject({
  kind: z.literal('tool_use'),
  callId: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
  /** Arguments as the model emitted them — JSON text, not a parsed object. */
  argumentsJson: z.string().max(1_000_000),
});

/** What running that tool produced, fed back in on the next turn. */
export const toolResultPartSchema = z.strictObject({
  kind: z.literal('tool_result'),
  callId: z.string().min(1).max(200),
  content: z.string().max(1_000_000),
  isError: z.boolean().optional(),
});

export const textPartSchema = z.strictObject({
  kind: z.literal('text'),
  text: z.string().max(1_000_000),
});

/**
 * An image, inline as base64.
 *
 * Inline rather than a CAS hash because the gateway must stay usable from the
 * orchestrator process without a database handle; the caller reads the blob and
 * passes the bytes.
 */
export const imagePartSchema = z.strictObject({
  kind: z.literal('image'),
  mediaType: z.string().min(1).max(120),
  dataBase64: z.string().min(1),
});

export const contentPartSchema = z.discriminatedUnion('kind', [
  textPartSchema,
  imagePartSchema,
  toolUsePartSchema,
  toolResultPartSchema,
]);
export type ContentPart = z.infer<typeof contentPartSchema>;

/**
 * One turn.
 *
 * Only `user` and `assistant`: a system prompt is a field on the request, not a
 * message, because half the providers model it that way and the ones that do
 * not can prepend it themselves.
 */
export const normalizedMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.array(contentPartSchema).min(1),
});
export type NormalizedMessage = z.infer<typeof normalizedMessageSchema>;

/** A tool offered to the model. `parameters` is a JSON Schema object. */
export const toolSpecSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9_-]+$/, 'tool names must be alphanumeric, dash or underscore'),
  description: z.string().min(1).max(4_000),
  parameters: z.record(z.string(), z.unknown()),
});
export type ToolSpec = z.infer<typeof toolSpecSchema>;

export const toolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.strictObject({ kind: z.literal('tool'), name: z.string().min(1).max(120) }),
]);
export type ToolChoice = z.infer<typeof toolChoiceSchema>;

export const responseFormatSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text') }),
  z.strictObject({
    kind: z.literal('json_schema'),
    name: z.string().min(1).max(120),
    schema: z.record(z.string(), z.unknown()),
  }),
]);
export type ResponseFormat = z.infer<typeof responseFormatSchema>;

/**
 * Provenance the gateway carries but never sends to a provider.
 *
 * Phase 16 hashes the request into the CAS and Phase 17 attributes spend; both
 * need to know which session and round a call belonged to without threading a
 * second argument through every adapter.
 */
export const requestMetadataSchema = z.strictObject({
  sessionId: idSchema.optional(),
  phaseId: idSchema.optional(),
  roundId: idSchema.optional(),
  participantId: idSchema.optional(),
});
export type RequestMetadata = z.infer<typeof requestMetadataSchema>;

/**
 * `maxOutputTokens` is required, not defaulted.
 *
 * A missing cap is how a runaway generation quietly spends real money, and a
 * default here would be a number invented by the gateway rather than chosen by
 * the caller — which the budget governor would then have to trust.
 */
export const normalizedRequestSchema = z.strictObject({
  modelId: modelIdSchema,
  system: z.string().max(1_000_000).nullable(),
  messages: z.array(normalizedMessageSchema).min(1),
  tools: z.array(toolSpecSchema).optional(),
  toolChoice: toolChoiceSchema.optional(),
  responseFormat: responseFormatSchema.optional(),
  maxOutputTokens: tokenCountSchema.min(1),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  stopSequences: z.array(z.string().min(1).max(200)).max(16).optional(),
  seed: z.number().int().optional(),
  /**
   * This request's beginning will be sent again: ask the provider to keep it.
   * Only where that is a request — Anthropic's. OpenAI-dialect providers and
   * Gemini keep a repeated prefix on their own, and a one-off call that asked
   * would pay to store what nothing reads again.
   */
  cachePrefix: z.boolean().optional(),
  metadata: requestMetadataSchema.optional(),
});
export type NormalizedRequest = z.infer<typeof normalizedRequestSchema>;

/**
 * The capabilities this request actually exercises.
 *
 * Derived from the request rather than declared by the caller, so a field added
 * to `NormalizedRequest` without a matching rule here is a visible omission
 * rather than a silently unchecked capability.
 */
export function requiredCapabilities(request: NormalizedRequest): ModelCapability[] {
  const needed = new Set<ModelCapability>(['streaming']);

  if (request.system !== null) needed.add('systemPrompt');
  if (request.tools && request.tools.length > 0) needed.add('tools');
  if (request.toolChoice !== undefined) needed.add('tools');
  if (request.responseFormat?.kind === 'json_schema') needed.add('jsonSchemaOutput');
  if (request.stopSequences && request.stopSequences.length > 0) needed.add('stopSequences');
  if (request.temperature !== undefined) needed.add('temperature');
  if (request.topP !== undefined) needed.add('topP');
  if (request.seed !== undefined) needed.add('seed');

  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind === 'image') needed.add('vision');
      if (part.kind === 'tool_use' || part.kind === 'tool_result') needed.add('tools');
    }
  }

  return [...needed];
}

/** What the request needs and the model does not have. Empty means go. */
export function missingCapabilities(
  descriptor: ModelDescriptor,
  request: NormalizedRequest,
): ModelCapability[] {
  return requiredCapabilities(request).filter((name) => !descriptor.capabilities[name]);
}

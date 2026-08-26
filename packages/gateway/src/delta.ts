import { modelIdSchema, tokenCountSchema, vendorIdSchema } from '@sheep/core';
import { z } from 'zod';

/**
 * The one streaming vocabulary every adapter speaks.
 *
 * Providers disagree about almost everything above the wire — SSE event names,
 * whether tool arguments arrive whole or in fragments, whether usage comes
 * first or last. A `Delta` is what survives that translation, and it is the
 * only thing the orchestrator and the renderer ever see.
 */

/** Token counts as the provider reported them. Money is added later. */
export const tokenUsageSchema = z.strictObject({
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  /** Billed at the cache-read rate, never folded into `inputTokens`. */
  cachedInputTokens: tokenCountSchema.optional(),
  cacheWriteTokens: tokenCountSchema.optional(),
  /** Counted inside `outputTokens` by every vendor so far; reported for display. */
  reasoningTokens: tokenCountSchema.optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const STOP_REASONS = [
  'stop',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'content_filter',
  'cancelled',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];
export const stopReasonSchema = z.enum(STOP_REASONS);

/**
 * Which weights answered, as the response itself reported them.
 *
 * Sent on `start` rather than assumed from the request, because an alias can
 * resolve to a different snapshot than the one the roster names — and P1 only
 * holds if provenance records what actually replied.
 */
export const respondingModelSchema = z.strictObject({
  vendorId: vendorIdSchema,
  modelId: modelIdSchema,
  version: z.string().min(1).max(200).optional(),
});
export type RespondingModel = z.infer<typeof respondingModelSchema>;

export const deltaSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('start'),
    model: respondingModelSchema,
    /** The provider's own id for this exchange, for support tickets and logs. */
    providerRequestId: z.string().min(1).max(200).optional(),
  }),
  z.strictObject({ kind: z.literal('text'), text: z.string() }),
  /** Visible chain-of-thought, kept apart from the answer so it never becomes one. */
  z.strictObject({ kind: z.literal('reasoning'), text: z.string() }),
  z.strictObject({
    kind: z.literal('tool_call_start'),
    callId: z.string().min(1).max(200),
    name: z.string().min(1).max(120),
  }),
  z.strictObject({
    kind: z.literal('tool_call_delta'),
    callId: z.string().min(1).max(200),
    /** A fragment of the JSON argument text. Not parseable on its own. */
    argumentsJson: z.string(),
  }),
  z.strictObject({
    kind: z.literal('tool_call_end'),
    callId: z.string().min(1).max(200),
  }),
  /** An interim usage report. Providers that only report at the end skip this. */
  z.strictObject({ kind: z.literal('usage'), usage: tokenUsageSchema }),
  z.strictObject({
    kind: z.literal('end'),
    stopReason: stopReasonSchema,
    usage: tokenUsageSchema,
  }),
]);
export type Delta = z.infer<typeof deltaSchema>;
export type DeltaKind = Delta['kind'];

/** A tool call, once its fragments have been reassembled. */
export interface CompletedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}

/** Everything a stream said, after the stream is over. */
export interface CollectedResponse {
  readonly model: RespondingModel;
  readonly providerRequestId?: string;
  readonly text: string;
  readonly reasoning: string;
  readonly toolCalls: readonly CompletedToolCall[];
  readonly stopReason: StopReason;
  readonly usage: TokenUsage;
}

/**
 * Drain a stream into one response.
 *
 * The non-streaming view of a streaming API: useful wherever a caller wants the
 * whole answer (a connection test, a title generator, a test assertion) and
 * would otherwise write this loop again. Assumes the stream is well-formed —
 * run it through `AdapterRegistry.stream`, which guarantees that.
 */
export async function collectDeltas(deltas: AsyncIterable<Delta>): Promise<CollectedResponse> {
  let model: RespondingModel | undefined;
  let providerRequestId: string | undefined;
  let text = '';
  let reasoning = '';
  let stopReason: StopReason | undefined;
  let usage: TokenUsage | undefined;
  const names = new Map<string, string>();
  const args = new Map<string, string>();
  const order: string[] = [];

  for await (const delta of deltas) {
    switch (delta.kind) {
      case 'start':
        model = delta.model;
        providerRequestId = delta.providerRequestId;
        break;
      case 'text':
        text += delta.text;
        break;
      case 'reasoning':
        reasoning += delta.text;
        break;
      case 'tool_call_start':
        names.set(delta.callId, delta.name);
        args.set(delta.callId, '');
        order.push(delta.callId);
        break;
      case 'tool_call_delta':
        args.set(delta.callId, (args.get(delta.callId) ?? '') + delta.argumentsJson);
        break;
      case 'tool_call_end':
        break;
      case 'usage':
        usage = delta.usage;
        break;
      case 'end':
        stopReason = delta.stopReason;
        usage = delta.usage;
        break;
    }
  }

  if (!model || !stopReason || !usage) {
    throw new Error('collectDeltas: the stream ended without start or end deltas');
  }

  return {
    model,
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
    text,
    reasoning,
    toolCalls: order.map((callId) => ({
      callId,
      name: names.get(callId) ?? '',
      argumentsJson: args.get(callId) ?? '',
    })),
    stopReason,
    usage,
  };
}

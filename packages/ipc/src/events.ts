import { z } from 'zod';
import {
  idSchema,
  messageFinishReasonSchema,
  modelIdSchema,
  tokenCountSchema,
  usdSchema,
  vendorIdSchema,
} from '@sheep/core';
import type { IpcEventChannel } from './channels';

/**
 * Main → renderer messages.
 *
 * `invoke` is request/response and cannot carry a stream, so a run's deltas
 * arrive on a one-way channel instead. The same rule applies as everywhere else
 * on this bridge: the channel is on an allowlist, and both ends validate the
 * payload — a renderer that trusted whatever arrived on an event channel would
 * be a renderer that could be driven by anything able to send one.
 *
 * Every event names its `runId`. Six concurrent streams share one channel, and
 * a delta that could not say which run it belonged to would be unroutable.
 */

const runScope = { runId: idSchema };

export const streamEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...runScope,
    kind: z.literal('start'),
    sessionId: idSchema,
    participantId: idSchema,
    /** The id the assistant's message will be recorded under when it ends. */
    messageId: idSchema,
    /** Which weights answered, as the response itself reported them. */
    model: z.strictObject({
      vendorId: vendorIdSchema,
      modelId: modelIdSchema,
      version: z.string().min(1).max(200).optional(),
    }),
  }),
  /** Answer text. Coalesced before it is sent; see the batcher in Phase 21. */
  z.strictObject({ ...runScope, kind: z.literal('text'), text: z.string() }),
  /** Visible thinking, kept apart from the answer so it never becomes one. */
  z.strictObject({ ...runScope, kind: z.literal('reasoning'), text: z.string() }),
  z.strictObject({
    ...runScope,
    kind: z.literal('end'),
    messageId: idSchema,
    finish: messageFinishReasonSchema,
    inputTokens: tokenCountSchema,
    outputTokens: tokenCountSchema,
    /** Null when the model has no price on file, which is not the same as free. */
    costUsd: usdSchema.nullable(),
    /** True when the text is what survived rather than what the model finished. */
    partial: z.boolean(),
  }),
  /**
   * The run failed.
   *
   * Whatever text had already arrived is still persisted under `messageId`, so
   * this is a report rather than a retraction.
   */
  z.strictObject({
    ...runScope,
    kind: z.literal('error'),
    messageId: idSchema,
    message: z.string().min(1).max(2_000),
    /** The gateway's stable error code, when the failure carried one. */
    code: z.string().min(1).max(80).optional(),
  }),
]);
export type StreamEvent = z.infer<typeof streamEventSchema>;

/** Every event channel's payload schema. */
export const IPC_EVENT_CONTRACTS = {
  'sheep:stream-event': streamEventSchema,
} as const satisfies Record<IpcEventChannel, z.ZodType>;

export type IpcEventContracts = typeof IPC_EVENT_CONTRACTS;

export type IpcEventPayload<C extends IpcEventChannel> = z.infer<IpcEventContracts[C]>;

export function eventContractFor<C extends IpcEventChannel>(channel: C): IpcEventContracts[C] {
  return IPC_EVENT_CONTRACTS[channel];
}

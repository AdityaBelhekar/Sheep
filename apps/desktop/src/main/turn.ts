import type { ModelRef, MessageFinishReason } from '@sheep/core';
import {
  PricingTable,
  collectDeltas,
  estimateInputTokens,
  priceUsage,
  type NormalizedRequest,
} from '@sheep/gateway';
import { getSession, listParticipants } from '@sheep/store';
import { assertWithinCaps } from './budget';
import { getAdapterRegistry, syncConnections } from './connections';
import { getStore } from './store';

/**
 * One protocol turn, start to finish, with nothing recorded.
 *
 * The chat surface streams to a window and writes the answer down; this does
 * neither. The orchestrator owns what a turn means — which phase and round it
 * belongs to, what role produced it, whether it has already been answered — so
 * main's job here is narrow on purpose: check the cap, call the provider, wait
 * for the whole answer, and hand back what it cost.
 *
 * Deltas are collected rather than streamed because a protocol turn is only
 * useful complete. Six models half-answering a framing prompt is not four
 * fifths of a framing round; it is nothing until every one of them has
 * committed (P3).
 */

/** A ceiling, not a target. Protocol turns are longer than chat turns. */
const MAX_OUTPUT_TOKENS = 4_096;

const pricing = new PricingTable();

export interface RunTurnInput {
  readonly sessionId: string;
  readonly participantId: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export interface RunTurnResult {
  readonly text: string;
  readonly model: ModelRef;
  readonly usage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
  readonly finish: MessageFinishReason;
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const store = getStore();

  const session = getSession(store.db, input.sessionId);
  if (!session) throw new Error(`unknown session: ${input.sessionId}`);

  const participant = listParticipants(store.db, input.sessionId, { attachedOnly: true }).find(
    (entry) => entry.participantId === input.participantId,
  );
  if (!participant) throw new Error('that model is not attached to this session');

  const connection = store.connections.get(participant.model.connectionId);
  if (!connection) throw new Error('the connection this model came through is gone');

  await syncConnections();
  const registry = getAdapterRegistry();
  if (!registry.has(connection.adapterId)) {
    throw new Error(`${connection.label} is not available; test it in Connections`);
  }

  const descriptor = await registry.describe(connection.adapterId, participant.model.modelId);
  const request: NormalizedRequest = {
    modelId: participant.model.modelId,
    system: input.system,
    messages: [{ role: 'user', content: [{ kind: 'text', text: input.prompt }] }],
    maxOutputTokens: Math.min(
      input.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
      descriptor.maxOutputTokens,
    ),
    metadata: { sessionId: input.sessionId, participantId: input.participantId },
  };

  // Priced at `maxOutputTokens` — the worst case, not a guess at the likely
  // one, for the same reason the chat surface does it: a budget that assumed
  // the average would be right about the average and wrong when it mattered.
  const rates = pricing.priceFor(descriptor);
  const estimate = rates
    ? priceUsage(
        rates,
        { inputTokens: estimateInputTokens(request), outputTokens: request.maxOutputTokens },
        'estimated',
      )
    : null;
  assertWithinCaps(session.budget, participant, estimate?.costUsd ?? null, rates === null);

  const collected = await collectDeltas(
    registry.stream(
      connection.adapterId,
      request,
      input.signal === undefined ? {} : { signal: input.signal },
    ),
  );

  const usage = collected.usage ?? { inputTokens: 0, outputTokens: 0 };
  const cost = rates ? priceUsage(rates, usage, 'measured') : null;

  return {
    // Reasoning stands in only when there is no answer at all: a model that
    // thought out loud and then stopped still produced something the log should
    // keep, but visible thinking must never be promoted to an answer.
    text: collected.text || collected.reasoning,
    model: {
      ...participant.model,
      ...(collected.model.version === undefined ? {} : { version: collected.model.version }),
    },
    usage: cost
      ? { inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, costUsd: cost.costUsd }
      : null,
    finish: collected.stopReason ?? 'stop',
  };
}

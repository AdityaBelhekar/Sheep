import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { domainEvent, type Message, type MessageFinishReason, type ModelRef } from '@sheep/core';
import {
  GatewayError,
  PricingTable,
  StreamCancelledError,
  canonicalJson,
  estimateInputTokens,
  hashOf,
  priceUsage,
  type NormalizedMessage,
  type NormalizedRequest,
  type StopReason,
  type TokenUsage,
} from '@sheep/gateway';
import { getSession, listMessages, listParticipants } from '@sheep/store';
import { assertWithinCaps } from './budget';
import { getAdapterRegistry, syncConnections } from './connections';
import { logError, logWarn } from './log';
import { getStore } from './store';
import { StreamPublisher } from './stream';

/**
 * One turn, end to end.
 *
 * The order of operations is the whole design, and every step of it is chosen
 * so that a crash cannot leave the record lying:
 *
 * 1. The user's message is recorded *before* the call. A question that reached
 *    a provider and then vanished would make the answer inexplicable.
 * 2. The cap is checked before the call, never during. Killing a stream halfway
 *    wastes tokens already paid for and leaves a truncated answer in the
 *    ledger, so a call that would cross the line is refused before it starts.
 * 3. The answer is recorded when the stream ends — including when it ends
 *    badly. Cancelled and failed runs persist whatever arrived, marked as such.
 * 4. Spend is recorded from the provider's own usage report, never from the
 *    estimate. The estimate was the worst case; billing it would be wrong twice.
 */

/** What the model is told it is doing, before any protocol phase exists. */
const SYSTEM_PROMPT =
  'You are one participant in a multi-model research session. Answer the question ' +
  'put to you directly and concisely. State what you are uncertain about rather ' +
  'than smoothing over it, and do not claim an empirical result you have not seen ' +
  'produced.';

/** A ceiling, not a target. Required by the gateway so nothing runs away. */
const MAX_OUTPUT_TOKENS = 2_048;

/** How much history one turn carries. Enough for a conversation, bounded. */
const HISTORY_LIMIT = 40;

interface Run {
  readonly runId: string;
  readonly sessionId: string;
  readonly participantId: string;
  readonly assistantMessageId: string;
  readonly controller: AbortController;
  readonly publisher: StreamPublisher;
}

const runs = new Map<string, Run>();

/** Prices, with room for the user's own overrides in a later phase. */
const pricing = new PricingTable();

export interface SendChatInput {
  readonly sessionId: string;
  readonly participantId: string;
  readonly text: string;
}

export interface SendChatResult {
  readonly runId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly estimatedCostUsd: number | null;
}

export async function sendChat(
  window: BrowserWindow,
  input: SendChatInput,
): Promise<SendChatResult> {
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
  const history = listMessages(store.db, input.sessionId, { limit: HISTORY_LIMIT });

  const request: NormalizedRequest = {
    modelId: participant.model.modelId,
    system: SYSTEM_PROMPT,
    messages: [
      ...toNormalized(history),
      { role: 'user', content: [{ kind: 'text', text: input.text }] },
    ],
    maxOutputTokens: Math.min(MAX_OUTPUT_TOKENS, descriptor.maxOutputTokens),
    metadata: { sessionId: input.sessionId, participantId: input.participantId },
  };

  // Priced at `maxOutputTokens` — the worst case, not a guess at the likely
  // one. A budget that assumed the average would be right about the average and
  // wrong exactly when it mattered.
  const rates = pricing.priceFor(descriptor);
  const estimate = rates
    ? priceUsage(
        rates,
        { inputTokens: estimateInputTokens(request), outputTokens: request.maxOutputTokens },
        'estimated',
      )
    : null;

  assertWithinCaps(session.budget, participant, estimate?.costUsd ?? null, rates === null);

  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();

  // Recorded before the call: a question that reached a provider and then
  // vanished would make the answer that followed it inexplicable.
  store.record([
    domainEvent('message.recorded', {
      sessionId: input.sessionId,
      messageId: userMessageId,
      author: { kind: 'HUMAN' },
      body: { kind: 'text', text: input.text },
    }),
  ]);

  const runId = randomUUID();
  const run: Run = {
    runId,
    sessionId: input.sessionId,
    participantId: input.participantId,
    assistantMessageId,
    controller: new AbortController(),
    publisher: new StreamPublisher(window),
  };
  runs.set(runId, run);

  // Deliberately not awaited: the reply below tells the renderer where to
  // listen, and the answer arrives on that channel as it is generated.
  void drive(run, connection.adapterId, request, participant.model, descriptor.pricing ?? rates);

  return {
    runId,
    userMessageId,
    assistantMessageId,
    estimatedCostUsd: estimate?.costUsd ?? null,
  };
}

/** True when there was a live run to stop. False is late, not wrong. */
export function cancelChat(runId: string): boolean {
  const run = runs.get(runId);
  if (!run) return false;
  run.controller.abort();
  return true;
}

/** Stops everything in flight — used when the window goes away. */
export function cancelAllChats(): void {
  for (const run of runs.values()) run.controller.abort();
}

async function drive(
  run: Run,
  adapterId: string,
  request: NormalizedRequest,
  model: ModelRef,
  rates: ReturnType<PricingTable['priceFor']>,
): Promise<void> {
  const store = getStore();
  // The exact request that produced this answer, addressed by hash — the
  // reproducibility half of P5, and the same digest the CAS transcript uses.
  const promptHash = hashOf(canonicalJson(request));

  let text = '';
  let reasoning = '';
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason | null = null;
  let failure: Error | null = null;
  let started = false;

  try {
    for await (const delta of getAdapterRegistry().stream(adapterId, request, {
      signal: run.controller.signal,
    })) {
      switch (delta.kind) {
        case 'start':
          started = true;
          run.publisher.push({
            runId: run.runId,
            kind: 'start',
            sessionId: run.sessionId,
            participantId: run.participantId,
            messageId: run.assistantMessageId,
            model: delta.model,
          });
          break;
        case 'text':
          text += delta.text;
          run.publisher.push({ runId: run.runId, kind: 'text', text: delta.text });
          break;
        case 'reasoning':
          reasoning += delta.text;
          run.publisher.push({ runId: run.runId, kind: 'reasoning', text: delta.text });
          break;
        case 'usage':
          usage = delta.usage;
          break;
        case 'end':
          usage = delta.usage;
          stopReason = delta.stopReason;
          break;
        default:
          // Tool calls are the orchestrator's business (Stage 8), not this
          // surface's; they are recorded in the CAS transcript regardless.
          break;
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const cancelled = run.controller.signal.aborted || failure instanceof StreamCancelledError;
  const finish: MessageFinishReason = cancelled
    ? 'cancelled'
    : failure
      ? 'error'
      : toFinish(stopReason);

  const cost = rates ? priceUsage(rates, usage, 'measured') : null;

  try {
    // Even a failed run is recorded: the tokens were spent, the text that
    // arrived is real, and a run that vanished without trace is not
    // reproducible (P5).
    store.record([
      domainEvent('message.recorded', {
        sessionId: run.sessionId,
        messageId: run.assistantMessageId,
        author: { kind: 'MODEL', participantId: run.participantId, model },
        body: { kind: 'text', text: text || reasoning },
        ...(cost
          ? {
              usage: {
                inputTokens: cost.inputTokens,
                outputTokens: cost.outputTokens,
                costUsd: cost.costUsd,
              },
            }
          : {}),
        finish,
        params: { maxOutputTokens: request.maxOutputTokens },
        promptHash,
      }),
      ...(cost && cost.costUsd > 0
        ? [
            domainEvent('session.spend-recorded', {
              sessionId: run.sessionId,
              costUsd: cost.costUsd,
              messageId: run.assistantMessageId,
            }),
          ]
        : []),
    ]);
  } catch (error) {
    // A failure to persist is worse than a failure to answer; say so loudly and
    // still close the stream, so the renderer is never left waiting.
    logError('the answer could not be recorded -', error);
  }

  if (failure && !cancelled) {
    logWarn(`run ${run.runId} failed -`, failure);
    run.publisher.push({
      runId: run.runId,
      kind: 'error',
      messageId: run.assistantMessageId,
      message: failure.message.slice(0, 2_000),
      ...(failure instanceof GatewayError ? { code: failure.code } : {}),
    });
  }

  run.publisher.push({
    runId: run.runId,
    kind: 'end',
    messageId: run.assistantMessageId,
    finish,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: cost?.costUsd ?? null,
    partial: cancelled || failure !== null || !started,
  });

  run.publisher.close();
  runs.delete(run.runId);
}

/**
 * The session's turns as the gateway's vocabulary.
 *
 * Blob bodies are skipped rather than fetched: this surface only ever writes
 * text, so a blob here would be from a later phase whose content this prompt
 * has no business reconstructing.
 */
function toNormalized(messages: readonly Message[]): NormalizedMessage[] {
  const wire: NormalizedMessage[] = [];
  for (const message of messages) {
    if (message.body.kind !== 'text' || message.body.text === '') continue;
    if (message.author.kind === 'SYSTEM') continue;
    wire.push({
      role: message.author.kind === 'MODEL' ? 'assistant' : 'user',
      content: [{ kind: 'text', text: message.body.text }],
    });
  }
  return wire;
}

function toFinish(stopReason: StopReason | null): MessageFinishReason {
  return stopReason ?? 'error';
}

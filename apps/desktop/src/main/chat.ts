import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import {
  domainEvent,
  type Message,
  type MessageFinishReason,
  type ModelRef,
  type RosterEntry,
  type SessionSummary,
} from '@sheep/core';
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
import { getSession, listParticipants, listThread } from '@sheep/store';
import { assertWithinCaps } from './budget';
import { getAdapterRegistry, syncConnections } from './connections';
import { logError, logWarn } from './log';
import { getStore } from './store';
import { StreamPublisher } from './stream';

/**
 * The chat: one room every attached model reads and answers in, and a private
 * thread with each model beside it.
 *
 * A message to the room is answered by every model in turn, in roster order,
 * and each one is shown the whole room — the person's messages and what the
 * other models said, under their names — before it speaks. So the second model
 * answers the first as well as the person, and asking them to carry on makes
 * another pass with nothing new from the person in it. A private message is
 * between the person and one model: that model reads it with the room around
 * it, and neither half of it is ever put in front of another model.
 *
 * Within one turn, the order of operations is the whole design, and every step
 * of it is chosen so that a crash cannot leave the record lying:
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

/** What every model in a chat is held to, whoever else is in it. */
const GROUND_RULES =
  'Be concise. State what you are uncertain about rather than smoothing over it, and do ' +
  'not claim an empirical result you have not seen produced.';

/** What stands in for the person when the models are asked to carry on. */
const CARRY_ON =
  '[Sheep] The person has asked the models to carry on. Respond to what the others said ' +
  'last: say where you agree, where you do not and why, or what follows from it.';

/** A ceiling, not a target. Required by the gateway so nothing runs away. */
const MAX_OUTPUT_TOKENS = 2_048;

/** How much history one turn carries. Enough for a conversation, bounded. */
const HISTORY_LIMIT = 40;

interface Run {
  readonly runId: string;
  readonly sessionId: string;
  readonly participant: RosterEntry;
  readonly assistantMessageId: string;
  /** Shared by every run of one send: stopping one stops what is left of it. */
  readonly controller: AbortController;
  readonly publisher: StreamPublisher;
  /** The participant a private exchange is with, on both of its halves. */
  readonly privateTo: string | undefined;
}

/** Everything one call needs, decided before anything is recorded. */
interface Prepared {
  readonly adapterId: string;
  readonly request: NormalizedRequest;
  readonly rates: ReturnType<PricingTable['priceFor']>;
  readonly estimatedCostUsd: number | null;
}

const runs = new Map<string, Run>();

/** Prices, with room for the user's own overrides in a later phase. */
const pricing = new PricingTable();

export interface SendChatInput {
  readonly sessionId: string;
  /** The one model that answers. Absent, every attached model does, in turn. */
  readonly participantId?: string | undefined;
  /** With `participantId`: a private exchange the other models never see. */
  readonly private?: boolean | undefined;
  /** Absent, with no `participantId`: the models carry on without the person. */
  readonly text?: string | undefined;
}

export interface SendChatResult {
  readonly runId: string;
  readonly userMessageId: string | null;
  readonly assistantMessageId: string;
  readonly runs: { runId: string; participantId: string; assistantMessageId: string }[];
  readonly estimatedCostUsd: number | null;
}

export async function sendChat(
  window: BrowserWindow,
  input: SendChatInput,
): Promise<SendChatResult> {
  const store = getStore();

  const session = getSession(store.db, input.sessionId);
  if (!session) throw new Error(`unknown session: ${input.sessionId}`);

  const attached = listParticipants(store.db, input.sessionId, { attachedOnly: true });
  const speakers =
    input.participantId === undefined
      ? attached
      : attached.filter((entry) => entry.participantId === input.participantId);
  if (speakers.length === 0) {
    throw new Error(
      input.participantId === undefined
        ? 'no model is attached to this session'
        : 'that model is not attached to this session',
    );
  }
  if (input.private === true && input.participantId === undefined) {
    throw new Error('a private message is to one model');
  }
  if (input.text === undefined && input.participantId !== undefined) {
    throw new Error('there is nothing to send');
  }

  const privateTo = input.private === true ? input.participantId : undefined;
  const controller = new AbortController();
  const batch: Run[] = speakers.map((participant) => ({
    runId: randomUUID(),
    sessionId: input.sessionId,
    participant,
    assistantMessageId: randomUUID(),
    controller,
    publisher: new StreamPublisher(window),
    privateTo,
  }));
  const [first, ...rest] = batch as [Run, ...Run[]];

  // The first call is prepared before anything is written down, so a send that
  // cannot start — a spent cap, a connection that is gone — records nothing.
  const prepared = await prepare(session, first, attached, input.text);

  const userMessageId = input.text === undefined ? null : randomUUID();
  if (userMessageId !== null && input.text !== undefined) {
    // Recorded before the call: a question that reached a provider and then
    // vanished would make the answer that followed it inexplicable.
    store.record([
      domainEvent('message.recorded', {
        sessionId: input.sessionId,
        messageId: userMessageId,
        author: { kind: 'HUMAN' },
        body: { kind: 'text', text: input.text },
        ...(privateTo === undefined ? {} : { privateTo }),
      }),
    ]);
  }

  for (const run of batch) runs.set(run.runId, run);

  // Deliberately not awaited: the reply below tells the renderer where to
  // listen, and the answers arrive on that channel as they are generated.
  void (async () => {
    await drive(first, prepared);
    // One after another, so each model reads what the one before it said.
    for (const run of rest) {
      if (controller.signal.aborted) {
        skip(run, 'cancelled', null);
        continue;
      }
      try {
        // Nothing pending: the person's message is in the thread by now.
        await drive(
          run,
          await prepare(session, run, attached, undefined, input.text === undefined),
        );
      } catch (error) {
        // One model that cannot answer does not silence the ones after it.
        logWarn(`run ${run.runId} could not start -`, error);
        skip(run, 'error', error instanceof Error ? error.message : String(error));
      }
    }
  })();

  return {
    runId: first.runId,
    userMessageId,
    assistantMessageId: first.assistantMessageId,
    runs: batch.map((run) => ({
      runId: run.runId,
      participantId: run.participant.participantId,
      assistantMessageId: run.assistantMessageId,
    })),
    estimatedCostUsd: prepared.estimatedCostUsd,
  };
}

/**
 * Builds one model's call from the thread as it stands, and checks it against
 * the caps. Throws rather than calling when the call may not be made.
 *
 * `pending` is what the person has just said and is not yet in the log.
 */
async function prepare(
  session: SessionSummary,
  run: Run,
  attached: readonly RosterEntry[],
  pending: string | undefined,
  carryOn = pending === undefined && run.privateTo === undefined && attached.length > 1,
): Promise<Prepared> {
  const store = getStore();
  const { participant } = run;

  const connection = store.connections.get(participant.model.connectionId);
  if (!connection) throw new Error('the connection this model came through is gone');

  await syncConnections();
  const registry = getAdapterRegistry();
  if (!registry.has(connection.adapterId)) {
    throw new Error(`${connection.label} is not available; test it in Connections`);
  }

  const descriptor = await registry.describe(connection.adapterId, participant.model.modelId);
  const isPrivate = run.privateTo !== undefined;
  const thread = listThread(store.db, run.sessionId, run.privateTo ?? null, HISTORY_LIMIT);
  const others = attached.filter((entry) => entry.participantId !== participant.participantId);
  // In a room of one there is nobody to tell apart, so nothing is labelled.
  const labelled = others.length > 0;

  const messages = toNormalized(thread, participant.participantId, labelled);
  if (pending !== undefined) {
    say(messages, 'user', labelled ? `${userLabel(isPrivate)} ${pending}` : pending);
  }
  // Only when the person said nothing: the models were asked to go on.
  if (carryOn && pending === undefined) {
    if (messages.length === 0) throw new Error('there is nothing to carry on from yet');
    say(messages, 'user', CARRY_ON);
  }

  const request: NormalizedRequest = {
    modelId: participant.model.modelId,
    system: systemPrompt(session, participant, others, isPrivate),
    messages,
    maxOutputTokens: Math.min(MAX_OUTPUT_TOKENS, descriptor.maxOutputTokens),
    metadata: { sessionId: run.sessionId, participantId: participant.participantId },
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

  // Read again rather than passed in: an earlier model in the same send has spent since.
  const budget = getSession(store.db, run.sessionId)?.budget ?? session.budget;
  assertWithinCaps(budget, participant, estimate?.costUsd ?? null, rates === null);

  return {
    adapterId: connection.adapterId,
    request,
    rates: descriptor.pricing ?? rates,
    estimatedCostUsd: estimate?.costUsd ?? null,
  };
}

/** What a model is told it is doing, which depends on who else can hear. */
function systemPrompt(
  session: SessionSummary,
  self: RosterEntry,
  others: readonly RosterEntry[],
  isPrivate: boolean,
): string {
  const about = `The session's research question is: ${session.question}`;
  if (isPrivate) {
    const names = others.map((entry) => entry.model.modelId).join(', ');
    return [
      `You are ${self.model.modelId}, one of several AI models in a group conversation with a`,
      `person${names === '' ? '' : ` and with ${names}`}. You can read the whole group conversation:`,
      'the person is marked [User] and each model by its name in square brackets. The person is',
      'now also talking to you privately; those messages are marked [User, privately], and the',
      'other models never see them or your replies to them. Reply as yourself, with no label.',
      GROUND_RULES,
      about,
    ].join(' ');
  }
  if (others.length === 0) {
    return [
      `You are ${self.model.modelId}, the one model in a research session. Answer the person directly.`,
      GROUND_RULES,
      about,
    ].join(' ');
  }
  const names = others.map((entry) => entry.model.modelId).join(', ');
  return [
    `You are ${self.model.modelId}, one of several AI models in a group conversation with a person.`,
    `The other models are: ${names}. Everyone sees every message. What the person says is marked`,
    '[User], and what another model says is marked with its name in square brackets.',
    'Reply as yourself, with no label. Engage with what the others said: agree, disagree and say',
    'why, or build on it, rather than repeating it.',
    GROUND_RULES,
    about,
  ].join(' ');
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

/** Ends a run that never reached its model, so nobody is left waiting on it. */
function skip(run: Run, finish: 'cancelled' | 'error', message: string | null): void {
  if (message !== null) {
    run.publisher.push({
      runId: run.runId,
      kind: 'error',
      messageId: run.assistantMessageId,
      message: message.slice(0, 2_000),
    });
  }
  run.publisher.push({
    runId: run.runId,
    kind: 'end',
    messageId: run.assistantMessageId,
    finish,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    partial: true,
  });
  run.publisher.close();
  runs.delete(run.runId);
}

async function drive(run: Run, prepared: Prepared): Promise<void> {
  const store = getStore();
  const { request, rates } = prepared;
  const model: ModelRef = run.participant.model;
  const participantId = run.participant.participantId;
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
    for await (const delta of getAdapterRegistry().stream(prepared.adapterId, request, {
      signal: run.controller.signal,
    })) {
      switch (delta.kind) {
        case 'start':
          started = true;
          run.publisher.push({
            runId: run.runId,
            kind: 'start',
            sessionId: run.sessionId,
            participantId,
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
        author: { kind: 'MODEL', participantId, model },
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
        ...(run.privateTo === undefined ? {} : { privateTo: run.privateTo }),
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
 * Adds a turn, folding it into the one before when the same side spoke twice.
 * Two models answering in a row are both "the other side" to a third, and some
 * providers refuse a conversation that does not alternate.
 */
function say(wire: NormalizedMessage[], role: 'user' | 'assistant', text: string): void {
  const last = wire.at(-1);
  const part = last?.role === role ? last.content.at(-1) : undefined;
  if (part?.kind === 'text') {
    last?.content.splice(-1, 1, { kind: 'text', text: `${part.text}\n\n${text}` });
  } else {
    wire.push({ role, content: [{ kind: 'text', text }] });
  }
}

/**
 * A thread as one model reads it: its own turns are its own, and everything
 * else is said to it — labelled with who said it, when there is more than one
 * other voice to tell apart.
 *
 * Blob bodies are skipped rather than fetched: this surface only ever writes
 * text, so a blob here would be from a later phase whose content this prompt
 * has no business reconstructing.
 */
function toNormalized(
  messages: readonly Message[],
  self: string,
  labelled: boolean,
): NormalizedMessage[] {
  const wire: NormalizedMessage[] = [];
  for (const message of messages) {
    if (message.body.kind !== 'text' || message.body.text === '') continue;
    const { author } = message;
    if (author.kind === 'SYSTEM') continue;
    if (author.kind === 'MODEL' && author.participantId === self) {
      say(wire, 'assistant', message.body.text);
    } else if (author.kind === 'MODEL') {
      say(wire, 'user', `[${author.model.modelId}] ${message.body.text}`);
    } else {
      const label = userLabel(message.privateTo !== null);
      say(wire, 'user', labelled ? `${label} ${message.body.text}` : message.body.text);
    }
  }
  return wire;
}

/** How the person is named to a model: privately, or in front of everyone. */
function userLabel(isPrivate: boolean): string {
  return isPrivate ? '[User, privately]' : '[User]';
}

function toFinish(stopReason: StopReason | null): MessageFinishReason {
  return stopReason ?? 'error';
}

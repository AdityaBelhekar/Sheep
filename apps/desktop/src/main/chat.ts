import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import {
  MAX_REASONING_LENGTH,
  domainEvent,
  type Attachment,
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
import { getSession, listParticipants, listThread, sessionBlobRef } from '@sheep/store';
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

/** Images every provider here takes. Anything else arrives as the text read out of it. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** How much of one attached text a model is shown. The whole of it stays in the record. */
const TEXT_IN_PROMPT = 100_000;

/**
 * The most one chat turn sends a model, in estimated tokens.
 *
 * Every model is sent the room on every turn, so a long chat is paid for again
 * by each of them each time. Past this, the oldest turns are left out — the
 * record keeps them — and the model is told they are there.
 */
const CONTEXT_BUDGET_TOKENS = 24_000;

/** Images are sent again only from this many recent turns; older ones are named instead. */
const IMAGE_TURNS = 6;

const LEFT_OUT = '[Sheep] Older turns of this conversation are left out to keep it short.';

type Part = NormalizedMessage['content'][number];

/** What the person has just sent and is not yet in the log. */
interface Pending {
  readonly text: string;
  readonly attachments: readonly Attachment[];
}

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

/**
 * Models that turned an image away, by adapter and model id. A catalogue that
 * cannot say which of its models see — Ollama Cloud's cannot — is believed
 * until a model refuses, and then that model is sent a note instead, for the
 * rest of the app's life.
 */
const unsighted = new Set<string>();
const sightKey = (adapterId: string, modelId: string): string => `${adapterId}\u0000${modelId}`;

/** A provider's way of saying a model takes no images. */
const NO_IMAGES = /image/i;

/** Prices, with room for the user's own overrides in a later phase. */
const pricing = new PricingTable();

export interface SendChatInput {
  readonly sessionId: string;
  /** The one model that answers. Absent, every attached model does, in turn. */
  readonly participantId?: string | undefined;
  /** With `participantId`: a private exchange the other models never see. */
  readonly private?: boolean | undefined;
  /** Absent, with no `participantId` and nothing attached: the models carry on without the person. */
  readonly text?: string | undefined;
  /** An image as it is, or the text read out of anything else. */
  readonly attachments?: readonly { name: string; mediaType: string; base64: string }[] | undefined;
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
  // Nothing said and nothing attached: the models are being asked to carry on.
  const nothing = input.text === undefined && (input.attachments?.length ?? 0) === 0;
  if (nothing && input.participantId !== undefined) {
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

  // Kept by content address before anything is asked of a model, so the
  // message below can name them. A refused send leaves them unreferenced.
  const attachments = storeAttachments(input.sessionId, input.attachments ?? []);
  const pending: Pending | undefined = nothing
    ? undefined
    : { text: input.text ?? '', attachments };

  // The first call is prepared before anything is written down, so a send that
  // cannot start — a spent cap, a connection that is gone — records nothing.
  const prepared = await prepare(session, first, attached, pending);

  const userMessageId = pending === undefined ? null : randomUUID();
  if (userMessageId !== null && pending !== undefined) {
    // Recorded before the call: a question that reached a provider and then
    // vanished would make the answer that followed it inexplicable.
    store.record([
      domainEvent('message.recorded', {
        sessionId: input.sessionId,
        messageId: userMessageId,
        author: { kind: 'HUMAN' },
        body: { kind: 'text', text: pending.text },
        ...(privateTo === undefined ? {} : { privateTo }),
        ...(attachments.length === 0 ? {} : { attachments }),
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
        await drive(run, await prepare(session, run, attached, undefined, nothing));
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
  pending: Pending | undefined,
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

  const vision =
    descriptor.capabilities.vision &&
    !unsighted.has(sightKey(connection.adapterId, participant.model.modelId));
  const messages = toNormalized(thread, participant.participantId, labelled, vision);
  if (pending !== undefined) {
    const label = labelled ? userLabel(isPrivate) : null;
    say(messages, 'user', userParts(pending.text, pending.attachments, label, vision));
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
  fitToBudget(
    request,
    Math.min(CONTEXT_BUDGET_TOKENS, descriptor.contextWindowTokens - request.maxOutputTokens),
  );

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
  const { rates } = prepared;
  let { request } = prepared;
  const model: ModelRef = run.participant.model;
  const participantId = run.participant.participantId;
  let text = '';
  let reasoning = '';
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason | null = null;
  let failure: Error | null;
  let started = false;

  for (let attempt = 0; ; attempt += 1) {
    failure = await stream(request).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    // Refused for an image before saying anything: once more, with each image
    // named instead of sent. Anything else is the failure it is.
    if (!failure || attempt > 0 || started || !hasImages(request)) break;
    if (!NO_IMAGES.test(failure.message)) break;
    unsighted.add(sightKey(prepared.adapterId, request.modelId));
    request = withoutImages(request);
  }
  // The exact request that produced this answer, addressed by hash — the
  // reproducibility half of P5, and the same digest the CAS transcript uses.
  const promptHash = hashOf(canonicalJson(request));

  async function stream(sent: NormalizedRequest): Promise<void> {
    for await (const delta of getAdapterRegistry().stream(prepared.adapterId, sent, {
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
        // The answer only. The thinking is kept beside it, so a reader can
        // fold it away and a later prompt never mistakes it for something said.
        body: { kind: 'text', text },
        ...(reasoning === '' ? {} : { reasoning: reasoning.slice(0, MAX_REASONING_LENGTH) }),
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
function say(wire: NormalizedMessage[], role: 'user' | 'assistant', said: string | Part[]): void {
  const parts: Part[] = typeof said === 'string' ? [{ kind: 'text', text: said }] : said;
  if (parts.length === 0) return;
  const last = wire.at(-1);
  if (last?.role !== role) {
    wire.push({ role, content: [...parts] });
    return;
  }
  for (const part of parts) {
    const tail = last.content.at(-1);
    if (part.kind === 'text' && tail?.kind === 'text') {
      last.content.splice(-1, 1, { kind: 'text', text: `${tail.text}\n\n${part.text}` });
    } else {
      last.content.push(part);
    }
  }
}

/**
 * Files sent with a message, checked and kept by content address.
 *
 * An image must be one every provider takes, and anything else must already be
 * text: the renderer reads a PDF's text out of it before sending, and a file
 * that is not valid UTF-8 is refused rather than handed to a model as noise.
 */
function storeAttachments(
  sessionId: string,
  files: readonly { name: string; mediaType: string; base64: string }[],
): Attachment[] {
  const store = getStore();
  return files.map((file) => {
    const data = Buffer.from(file.base64, 'base64');
    if (IMAGE_TYPES.has(file.mediaType)) {
      if (data.byteLength > MAX_IMAGE_BYTES) throw new Error(`${file.name} is larger than 8 MB`);
    } else if (file.mediaType === 'text/plain') {
      if (data.byteLength > MAX_TEXT_BYTES) throw new Error(`${file.name} is larger than 2 MB`);
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        throw new Error(`${file.name} is not text, so it cannot be sent`);
      }
    } else {
      throw new Error(`${file.name}: only images and text files can be attached`);
    }
    const { hash } = store.blobs.put(data, sessionBlobRef(sessionId));
    return { name: file.name, mediaType: file.mediaType, hash, bytes: data.byteLength };
  });
}

/**
 * What the person said, as a model is sent it: the words, then each file. An
 * image goes as an image to a model that can see; to one that cannot, it is
 * named so that its absence is not a mystery.
 */
function userParts(
  text: string,
  attachments: readonly Attachment[],
  label: string | null,
  vision: boolean,
  /** False for a turn far enough back that its images are named, not sent again. */
  recent = true,
): Part[] {
  const store = getStore();
  const parts: Part[] = [];
  const said = label === null ? text : `${label} ${text}`.trimEnd();
  if (said !== '') parts.push({ kind: 'text', text: said });
  for (const file of attachments) {
    if (file.mediaType.startsWith('image/')) {
      parts.push(
        vision && recent
          ? {
              kind: 'image',
              mediaType: file.mediaType,
              dataBase64: Buffer.from(store.blobs.read(file.hash)).toString('base64'),
            }
          : {
              kind: 'text',
              text: vision
                ? `[Attached image "${file.name}", shown earlier in the conversation]`
                : `[Attached image "${file.name}": this model cannot see images]`,
            },
      );
    } else {
      const content = store.blobs.readText(file.hash);
      const clipped =
        content.length > TEXT_IN_PROMPT
          ? `${content.slice(0, TEXT_IN_PROMPT)}\n[… the rest of the file is not shown]`
          : content;
      parts.push({ kind: 'text', text: `[Attached file "${file.name}"]\n${clipped}` });
    }
  }
  return parts;
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
  vision: boolean,
): NormalizedMessage[] {
  const wire: NormalizedMessage[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.body.kind !== 'text') continue;
    if (message.body.text === '' && message.attachments.length === 0) continue;
    // An image seen turns ago is not worth its tokens on every turn since.
    const recent = messages.length - index <= IMAGE_TURNS;
    const { author } = message;
    if (author.kind === 'SYSTEM') continue;
    if (author.kind === 'MODEL' && author.participantId === self) {
      say(wire, 'assistant', message.body.text);
    } else if (author.kind === 'MODEL') {
      say(wire, 'user', `[${author.model.modelId}] ${message.body.text}`);
    } else {
      const label = labelled ? userLabel(message.privateTo !== null) : null;
      say(wire, 'user', userParts(message.body.text, message.attachments, label, vision, recent));
    }
  }
  return wire;
}

/**
 * Leaves out the oldest turns until the request fits the budget, keeping the
 * newest whole. The conversation still starts with something said to the
 * model — providers refuse one that opens with its own answer — and it is told
 * what is missing rather than left to assume it saw everything.
 */
function fitToBudget(request: NormalizedRequest, budget: number): void {
  const messages = request.messages as NormalizedMessage[];
  let dropped = false;
  while (messages.length > 1 && estimateInputTokens(request) > budget) {
    messages.shift();
    while (messages.length > 1 && messages[0]?.role === 'assistant') messages.shift();
    dropped = true;
  }
  if (dropped) messages[0]?.content.unshift({ kind: 'text', text: LEFT_OUT });
}

function hasImages(request: NormalizedRequest): boolean {
  return request.messages.some((message) => message.content.some((part) => part.kind === 'image'));
}

/** The same request, with every image replaced by a line saying one was there. */
function withoutImages(request: NormalizedRequest): NormalizedRequest {
  return {
    ...request,
    messages: request.messages.map((message) => ({
      ...message,
      content: message.content.map((part) =>
        part.kind === 'image'
          ? { kind: 'text', text: '[An image was attached here: this model cannot see images]' }
          : part,
      ),
    })),
  };
}

/** How the person is named to a model: privately, or in front of everyone. */
function userLabel(isPrivate: boolean): string {
  return isPrivate ? '[User, privately]' : '[User]';
}

function toFinish(stopReason: StopReason | null): MessageFinishReason {
  return stopReason ?? 'error';
}

import type { AdapterId, ListModelsOptions, ModelAdapter, StreamOptions } from '../adapter';
import { resolveSecret, type SecretProvider } from '../credentials';
import type { Delta, StopReason, TokenUsage } from '../delta';
import { capabilities, type ModelDescriptor, type ModelPricing } from '../descriptor';
import { ProviderError } from '../errors';
import { HttpClient, type FetchLike } from '../http/client';
import type { NormalizedRequest, NormalizedMessage, ToolSpec } from '../request';

/**
 * Anthropic's Messages API.
 *
 * Raw HTTP rather than `@anthropic-ai/sdk` — a deliberate trade. The SDK's
 * value is retries, backoff and typed errors, all of which Sheep must own
 * anyway (Phase 16 applies one rate limiter, one breaker and one CAS recorder
 * across every vendor, and P5 wants the exact bytes that crossed the wire).
 * One transport for all providers is worth more here than four SDKs with four
 * retry policies underneath a layer that has to defeat them.
 */

export const ANTHROPIC_VENDOR_ID = 'anthropic';
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
/** The API version header. Pinned: a floating version is not reproducible. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** Cache reads bill at a tenth of input; cache writes at 1.25x. */
function pricing(input: number, output: number): ModelPricing {
  return {
    inputPerMTokUsd: input,
    outputPerMTokUsd: output,
    cachedInputPerMTokUsd: input * 0.1,
    cacheWritePerMTokUsd: input * 1.25,
  };
}

/**
 * Sampling was removed from the 5-series and from Opus 4.7/4.8: `temperature`
 * and `top_p` are rejected with a 400 rather than ignored. Declaring that here
 * turns a runtime 400 into a refusal Sheep can explain, and is the reason the
 * capability flags exist at all.
 */
const MODERN = capabilities({
  streaming: true,
  systemPrompt: true,
  tools: true,
  parallelToolCalls: true,
  vision: true,
  reasoning: true,
  jsonSchemaOutput: true,
  promptCaching: true,
  stopSequences: true,
});

/** Opus 4.6 and older still take `temperature`/`top_p`. None take a seed. */
const SAMPLING = capabilities({ ...MODERN, temperature: true, topP: true });

function model(
  modelId: string,
  displayName: string,
  contextWindowTokens: number,
  maxOutputTokens: number,
  price: ModelPricing,
  flags = MODERN,
): ModelDescriptor {
  return {
    vendorId: ANTHROPIC_VENDOR_ID,
    modelId,
    displayName,
    contextWindowTokens,
    maxOutputTokens,
    capabilities: flags,
    pricing: price,
    local: false,
  };
}

/**
 * The catalogue, with list prices as of 2026-06-24.
 *
 * Static rather than fetched: `GET /v1/models` returns ids and context windows
 * but no pricing, and a budget governor with no prices is decoration. Pass
 * `refresh: true` to merge in any model the account can see that is missing
 * here — those arrive with `pricing: null`, which is exactly the "cannot
 * predict the cost" state Phase 17 refuses to run under a cap.
 */
export const ANTHROPIC_MODELS: readonly ModelDescriptor[] = [
  model('claude-opus-5', 'Claude Opus 5', 1_000_000, 128_000, pricing(5, 25)),
  model('claude-fable-5', 'Claude Fable 5', 1_000_000, 128_000, pricing(10, 50)),
  model('claude-opus-4-8', 'Claude Opus 4.8', 1_000_000, 128_000, pricing(5, 25)),
  model('claude-opus-4-7', 'Claude Opus 4.7', 1_000_000, 128_000, pricing(5, 25)),
  model('claude-opus-4-6', 'Claude Opus 4.6', 1_000_000, 128_000, pricing(5, 25), SAMPLING),
  model('claude-sonnet-5', 'Claude Sonnet 5', 1_000_000, 128_000, pricing(3, 15)),
  model('claude-sonnet-4-6', 'Claude Sonnet 4.6', 1_000_000, 128_000, pricing(3, 15), SAMPLING),
  model('claude-haiku-4-5', 'Claude Haiku 4.5', 200_000, 64_000, pricing(1, 5), SAMPLING),
];

export interface AnthropicAdapterOptions {
  readonly adapterId?: AdapterId;
  readonly apiKey: SecretProvider;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  /**
   * `adaptive` asks for thinking and streams it as `reasoning` deltas;
   * `disabled` turns it off. Omitted takes the model's own default, which on
   * Opus 5 is adaptive with the text withheld.
   */
  readonly thinking?: 'adaptive' | 'disabled';
  /** `output_config.effort` — how hard the model works before answering. */
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly betas?: readonly string[];
  readonly timeoutMs?: number;
}

export class AnthropicAdapter implements ModelAdapter {
  readonly adapterId: AdapterId;
  readonly vendorId = ANTHROPIC_VENDOR_ID;
  readonly #options: AnthropicAdapterOptions;
  readonly #http: HttpClient;
  #discovered: ModelDescriptor[] | undefined;

  constructor(options: AnthropicAdapterOptions) {
    this.adapterId = options.adapterId ?? ANTHROPIC_VENDOR_ID;
    this.#options = options;
    this.#http = new HttpClient({
      adapterId: this.adapterId,
      baseUrl: options.baseUrl ?? ANTHROPIC_BASE_URL,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      headers: async () => ({
        'x-api-key': await resolveSecret(this.adapterId, options.apiKey),
        'anthropic-version': ANTHROPIC_API_VERSION,
        ...(options.betas && options.betas.length > 0
          ? { 'anthropic-beta': options.betas.join(',') }
          : {}),
      }),
    });
  }

  async listModels(options: ListModelsOptions = {}): Promise<ModelDescriptor[]> {
    if (!options.refresh) return [...ANTHROPIC_MODELS];

    this.#discovered ??= await this.#fetchCatalogue(options);
    const known = new Set(ANTHROPIC_MODELS.map((entry) => entry.modelId));
    return [...ANTHROPIC_MODELS, ...this.#discovered.filter((m) => !known.has(m.modelId))];
  }

  async describeModel(
    modelId: string,
    options: ListModelsOptions = {},
  ): Promise<ModelDescriptor | null> {
    const all = await this.listModels(options);
    return all.find((entry) => entry.modelId === modelId) ?? null;
  }

  async *stream(
    request: NormalizedRequest,
    options: StreamOptions = {},
  ): AsyncGenerator<Delta, void, undefined> {
    const events = this.#http.sse({
      method: 'POST',
      path: '/v1/messages',
      body: this.toWire(request),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    /** Content blocks arrive interleaved by index; this is the open set. */
    const blocks = new Map<number, { kind: 'text' | 'thinking' | 'tool_use'; callId?: string }>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = 'stop';

    for await (const event of events) {
      if (event.data.length === 0) continue;
      const payload = JSON.parse(event.data) as AnthropicEvent;

      switch (payload.type) {
        case 'message_start': {
          const message = payload.message;
          usage = mergeUsage(usage, message.usage);
          yield {
            kind: 'start',
            model: {
              vendorId: ANTHROPIC_VENDOR_ID,
              modelId: request.modelId,
              // The alias may resolve to different weights than were asked for;
              // provenance records what actually answered.
              ...(message.model ? { version: message.model } : {}),
            },
            ...(message.id ? { providerRequestId: message.id } : {}),
          };
          break;
        }

        case 'content_block_start': {
          const block = payload.content_block;
          if (block.type === 'tool_use') {
            blocks.set(payload.index, { kind: 'tool_use', callId: block.id });
            yield { kind: 'tool_call_start', callId: block.id, name: block.name };
          } else if (block.type === 'text') {
            blocks.set(payload.index, { kind: 'text' });
            if (block.text) yield { kind: 'text', text: block.text };
          } else {
            blocks.set(payload.index, { kind: 'thinking' });
            if (block.thinking) yield { kind: 'reasoning', text: block.thinking };
          }
          break;
        }

        case 'content_block_delta': {
          const open = blocks.get(payload.index);
          const delta = payload.delta;
          if (delta.type === 'text_delta') {
            yield { kind: 'text', text: delta.text };
          } else if (delta.type === 'thinking_delta') {
            yield { kind: 'reasoning', text: delta.thinking };
          } else if (delta.type === 'input_json_delta' && open?.callId) {
            yield {
              kind: 'tool_call_delta',
              callId: open.callId,
              argumentsJson: delta.partial_json,
            };
          }
          // signature_delta and citations_delta carry nothing Sheep streams.
          break;
        }

        case 'content_block_stop': {
          const open = blocks.get(payload.index);
          if (open?.kind === 'tool_use' && open.callId) {
            yield { kind: 'tool_call_end', callId: open.callId };
          }
          blocks.delete(payload.index);
          break;
        }

        case 'message_delta': {
          usage = mergeUsage(usage, payload.usage);
          if (payload.delta.stop_reason) stopReason = mapStopReason(payload.delta.stop_reason);
          break;
        }

        case 'message_stop':
          yield { kind: 'end', stopReason, usage };
          return;

        case 'error':
          throw toProviderError(this.adapterId, payload.error);

        default:
          break;
      }
    }
  }

  async countInputTokens(request: NormalizedRequest, options: StreamOptions = {}): Promise<number> {
    const wire = this.toWire(request);
    const body: Record<string, unknown> = { ...wire };
    delete body['max_tokens'];
    delete body['stream'];

    const response = await this.#http.json<{ input_tokens: number }>({
      method: 'POST',
      path: '/v1/messages/count_tokens',
      body,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return response.input_tokens;
  }

  /**
   * The normalized request, in Anthropic's shape.
   *
   * Public because Phase 16 records exactly what was sent, and a recording that
   * was re-derived rather than captured is not evidence of anything.
   */
  toWire(request: NormalizedRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.modelId,
      max_tokens: request.maxOutputTokens,
      stream: true,
      messages: request.messages.map(toWireMessage),
    };

    if (request.system !== null) body['system'] = request.system;
    if (request.tools && request.tools.length > 0) body['tools'] = request.tools.map(toWireTool);
    if (request.toolChoice) body['tool_choice'] = toWireToolChoice(request.toolChoice);
    if (request.stopSequences?.length) body['stop_sequences'] = [...request.stopSequences];
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.topP !== undefined) body['top_p'] = request.topP;
    // Top-level: the provider places the breakpoint after the last block, so
    // each turn reads the one before it from cache. A prefix too short to
    // cache is simply not cached; nothing fails.
    if (request.cachePrefix) body['cache_control'] = { type: 'ephemeral' };

    const outputConfig: Record<string, unknown> = {};
    if (this.#options.effort) outputConfig['effort'] = this.#options.effort;
    if (request.responseFormat?.kind === 'json_schema') {
      outputConfig['format'] = { type: 'json_schema', schema: request.responseFormat.schema };
    }
    if (Object.keys(outputConfig).length > 0) body['output_config'] = outputConfig;

    if (this.#options.thinking === 'adaptive') {
      // `display: 'summarized'` is what makes reasoning deltas have any text;
      // the default withholds it and the stream looks like a long pause.
      body['thinking'] = { type: 'adaptive', display: 'summarized' };
    } else if (this.#options.thinking === 'disabled') {
      body['thinking'] = { type: 'disabled' };
    }

    return body;
  }

  async #fetchCatalogue(options: ListModelsOptions): Promise<ModelDescriptor[]> {
    const response = await this.#http.json<{
      data: { id: string; display_name?: string; max_input_tokens?: number; max_tokens?: number }[];
    }>({
      method: 'GET',
      path: '/v1/models',
      query: { limit: '100' },
      ...(options.signal ? { signal: options.signal } : {}),
    });

    return response.data.map((entry) => ({
      vendorId: ANTHROPIC_VENDOR_ID,
      modelId: entry.id,
      displayName: entry.display_name ?? entry.id,
      contextWindowTokens: entry.max_input_tokens ?? 200_000,
      maxOutputTokens: entry.max_tokens ?? 8_192,
      capabilities: MODERN,
      // Unknown, not free: the Models API publishes no rates.
      pricing: null,
      local: false,
    }));
  }
}

function toWireMessage(message: NormalizedMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content.map((part) => {
      switch (part.kind) {
        case 'text':
          return { type: 'text', text: part.text };
        case 'image':
          return {
            type: 'image',
            source: { type: 'base64', media_type: part.mediaType, data: part.dataBase64 },
          };
        case 'tool_use':
          return {
            type: 'tool_use',
            id: part.callId,
            name: part.name,
            input: parseArguments(part.argumentsJson),
          };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: part.callId,
            content: part.content,
            ...(part.isError === undefined ? {} : { is_error: part.isError }),
          };
      }
    }),
  };
}

function toWireTool(tool: ToolSpec): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

function toWireToolChoice(choice: NonNullable<NormalizedRequest['toolChoice']>): unknown {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  // Anthropic spells "you must call something" as `any`.
  if (choice === 'required') return { type: 'any' };
  return { type: 'tool', name: choice.name };
}

/**
 * A model's own tool arguments, replayed back to it.
 *
 * `{}` on unparseable text rather than a throw: this is history being resent,
 * and refusing to continue a conversation because a past fragment was malformed
 * would lose the whole session over one bad turn.
 */
function parseArguments(argumentsJson: string): unknown {
  if (argumentsJson.trim().length === 0) return {};
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return {};
  }
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
    case 'pause_turn':
      return 'tool_use';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function mergeUsage(usage: TokenUsage, reported: AnthropicUsage | undefined): TokenUsage {
  if (!reported) return usage;
  return {
    inputTokens: reported.input_tokens ?? usage.inputTokens,
    outputTokens: reported.output_tokens ?? usage.outputTokens,
    ...(reported.cache_read_input_tokens === undefined
      ? usage.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: usage.cachedInputTokens }
      : { cachedInputTokens: reported.cache_read_input_tokens }),
    ...(reported.cache_creation_input_tokens === undefined
      ? usage.cacheWriteTokens === undefined
        ? {}
        : { cacheWriteTokens: usage.cacheWriteTokens }
      : { cacheWriteTokens: reported.cache_creation_input_tokens }),
  };
}

/**
 * An `error` event arrives on a 200 response, mid-stream.
 *
 * `overloaded_error` is Anthropic's 529 in stream clothing and must stay
 * retryable, or Phase 16's breaker would treat a busy minute as a dead vendor.
 */
function toProviderError(adapterId: string, error: { type?: string; message?: string }): Error {
  const type = error.type ?? 'api_error';
  const status = type === 'overloaded_error' ? 529 : type === 'rate_limit_error' ? 429 : 500;
  return new ProviderError(adapterId, status, error.message ?? type, {
    providerType: type,
    retryable: type === 'overloaded_error' || type === 'rate_limit_error' || type === 'api_error',
  });
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

type AnthropicEvent =
  | {
      type: 'message_start';
      message: { id?: string; model?: string; usage?: AnthropicUsage };
    }
  | {
      type: 'content_block_start';
      index: number;
      content_block:
        | { type: 'text'; text?: string }
        | { type: 'thinking' | 'redacted_thinking'; thinking?: string }
        | { type: 'tool_use'; id: string; name: string };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'signature_delta' | 'citations_delta' };
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: string }; usage?: AnthropicUsage }
  | { type: 'message_stop' }
  | { type: 'error'; error: { type?: string; message?: string } }
  | { type: 'ping' };

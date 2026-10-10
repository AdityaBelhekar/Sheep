import type { AdapterId, ListModelsOptions, ModelAdapter, StreamOptions } from '../adapter';
import { resolveSecret, type SecretProvider } from '../credentials';
import type { Delta, StopReason, TokenUsage } from '../delta';
import {
  capabilities,
  type CapabilityFlags,
  type ModelDescriptor,
  type ModelPricing,
  FREE_PRICING,
} from '../descriptor';
import { ProviderError } from '../errors';
import { HttpClient, type FetchLike } from '../http/client';
import type { NormalizedMessage, NormalizedRequest, ToolSpec } from '../request';

/**
 * The OpenAI Chat Completions shape — and every provider that copies it.
 *
 * There is one implementation here, not seven. Groq, Together, DeepSeek,
 * OpenRouter, xAI and Azure all speak this dialect, so the differences that
 * remain are data: a base URL, a header scheme, a path, whether the output cap
 * is spelled `max_tokens` or `max_completion_tokens`. Those live in
 * `OPENAI_COMPATIBLE_PRESETS`, which means adding the next such provider is a
 * table entry rather than a file — and means a bug fixed in the streaming
 * parser is fixed for all of them at once.
 */

export const OPENAI_VENDOR_ID = 'openai';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * What a chat-completions endpoint is assumed to do until told otherwise.
 *
 * Optimistic on purpose: these endpoints publish no capability metadata, so
 * either Sheep guesses permissively and lets a 400 correct it, or it refuses
 * features the server actually has. Anything known to be wrong for a specific
 * model is fixed with a `models` entry in the connection config, which is also
 * where a user pins prices.
 */
export const OPENAI_DEFAULT_CAPABILITIES: CapabilityFlags = capabilities({
  streaming: true,
  systemPrompt: true,
  tools: true,
  parallelToolCalls: true,
  vision: true,
  jsonSchemaOutput: true,
  stopSequences: true,
  temperature: true,
  topP: true,
  seed: true,
});

export interface OpenAiCompatibleOptions {
  readonly adapterId?: AdapterId;
  /** Whose weights these are. P1 compares this, so a proxy must name its vendor. */
  readonly vendorId?: string;
  readonly baseUrl?: string;
  readonly apiKey?: SecretProvider;
  readonly fetch?: FetchLike;
  /** `bearer` for almost everyone; `api-key` for Azure OpenAI. */
  readonly authScheme?: 'bearer' | 'api-key';
  /** Extra headers a provider insists on (OpenRouter's referer, for instance). */
  readonly headers?: Record<string, string>;
  /** Azure puts the deployment in the path; everyone else uses one endpoint. */
  readonly chatPath?: (modelId: string) => string;
  readonly modelsPath?: string;
  readonly query?: Record<string, string>;
  /** Newer OpenAI models reject `max_tokens`; most clones only know it. */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Ask for a usage block on the final chunk. Off for servers that choke. */
  readonly includeUsage?: boolean;
  /** A fixed catalogue. Without one, models come from `GET /models`. */
  readonly models?: readonly ModelDescriptor[];
  /** Prices for discovered models, per model id. The user's own table. */
  readonly modelPricing?: Readonly<Record<string, ModelPricing>>;
  /** The price of a model nothing else prices. For a provider that bills no call. */
  readonly defaultPricing?: ModelPricing;
  readonly defaultCapabilities?: CapabilityFlags;
  readonly defaultContextWindowTokens?: number;
  readonly defaultMaxOutputTokens?: number;
  readonly local?: boolean;
  readonly timeoutMs?: number;
}

/** A named provider: everything above, minus the credential. */
export type OpenAiCompatiblePreset = Omit<OpenAiCompatibleOptions, 'apiKey' | 'adapterId'>;

/**
 * The providers Sheep ships knowing about.
 *
 * No prices: these change monthly and a wrong price is worse than an absent
 * one — an absent price makes the budget governor refuse to guess, a wrong one
 * makes it confidently overspend. Prices arrive from the connection settings,
 * except on OpenRouter, which publishes them per model and is read live.
 */
export const OPENAI_COMPATIBLE_PRESETS = {
  openai: {
    vendorId: 'openai',
    baseUrl: OPENAI_BASE_URL,
    maxTokensField: 'max_completion_tokens',
  },
  groq: {
    vendorId: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  together: {
    vendorId: 'together',
    baseUrl: 'https://api.together.xyz/v1',
  },
  deepseek: {
    vendorId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
  },
  openrouter: {
    vendorId: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  xai: {
    vendorId: 'xai',
    baseUrl: 'https://api.x.ai/v1',
  },
  // Ollama's hosted models, by API key. Not the local runtime: that is a
  // `local` connection, and takes no key.
  'ollama-cloud': {
    vendorId: 'ollama-cloud',
    baseUrl: 'https://ollama.com/v1',
    // Billed by subscription with a usage allowance, not by the token: a call
    // costs nothing, which is a price, and lets these models run under a cap.
    // The cap then counts nothing for them; Ollama's own limit is what stops.
    defaultPricing: FREE_PRICING,
  },
} as const satisfies Record<string, OpenAiCompatiblePreset>;

export type OpenAiPresetName = keyof typeof OPENAI_COMPATIBLE_PRESETS;

/** One code path, one provider chosen from config. */
export function createOpenAiAdapter(
  preset: OpenAiPresetName,
  options: Omit<OpenAiCompatibleOptions, keyof OpenAiCompatiblePreset> &
    Partial<OpenAiCompatiblePreset>,
): OpenAiCompatibleAdapter {
  return new OpenAiCompatibleAdapter({
    adapterId: preset,
    ...OPENAI_COMPATIBLE_PRESETS[preset],
    ...options,
  });
}

/**
 * Azure names a deployment, not a model, and versions by query parameter.
 *
 * It is the one dialect that changes the *shape* of the call rather than its
 * contents, which is exactly why `chatPath` and `query` are options: Azure
 * needed no new adapter, only two more fields.
 */
export function createAzureOpenAiAdapter(options: {
  readonly adapterId?: AdapterId;
  /** e.g. `https://my-resource.openai.azure.com` */
  readonly endpoint: string;
  readonly apiKey: SecretProvider;
  readonly apiVersion: string;
  readonly models?: readonly ModelDescriptor[];
  readonly modelPricing?: Readonly<Record<string, ModelPricing>>;
  readonly fetch?: FetchLike;
}): OpenAiCompatibleAdapter {
  return new OpenAiCompatibleAdapter({
    adapterId: options.adapterId ?? 'azure-openai',
    vendorId: 'openai',
    baseUrl: `${options.endpoint.replace(/\/$/, '')}/openai`,
    apiKey: options.apiKey,
    authScheme: 'api-key',
    chatPath: (modelId) => `/deployments/${modelId}/chat/completions`,
    modelsPath: '/models',
    query: { 'api-version': options.apiVersion },
    maxTokensField: 'max_completion_tokens',
    ...(options.models ? { models: options.models } : {}),
    ...(options.modelPricing ? { modelPricing: options.modelPricing } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export class OpenAiCompatibleAdapter implements ModelAdapter {
  readonly adapterId: AdapterId;
  readonly vendorId: string;
  readonly #options: OpenAiCompatibleOptions;
  readonly #http: HttpClient;
  #discovered: ModelDescriptor[] | undefined;

  constructor(options: OpenAiCompatibleOptions) {
    this.adapterId = options.adapterId ?? options.vendorId ?? OPENAI_VENDOR_ID;
    this.vendorId = options.vendorId ?? OPENAI_VENDOR_ID;
    this.#options = options;
    this.#http = new HttpClient({
      adapterId: this.adapterId,
      baseUrl: options.baseUrl ?? OPENAI_BASE_URL,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      headers: async () => {
        const headers: Record<string, string> = { ...options.headers };
        // A local server needs no key at all; asking for one would make
        // llama.cpp unreachable for the sake of a header nobody reads.
        if (options.apiKey !== undefined) {
          const key = await resolveSecret(this.adapterId, options.apiKey);
          if (options.authScheme === 'api-key') headers['api-key'] = key;
          else headers['authorization'] = `Bearer ${key}`;
        }
        return headers;
      },
    });
  }

  async listModels(options: ListModelsOptions = {}): Promise<ModelDescriptor[]> {
    if (this.#options.models) return [...this.#options.models];
    if (!options.refresh && this.#discovered) return [...this.#discovered];

    this.#discovered = await this.#fetchCatalogue(options);
    return [...this.#discovered];
  }

  async describeModel(
    modelId: string,
    options: ListModelsOptions = {},
  ): Promise<ModelDescriptor | null> {
    const all = await this.listModels(options);
    const found = all.find((entry) => entry.modelId === modelId);
    if (found) return found;

    // A deployment or fine-tune the catalogue endpoint does not list is still
    // callable; describe it from the defaults rather than refusing to try.
    if (this.#options.models) return null;
    return this.#describeUnlisted(modelId);
  }

  async *stream(
    request: NormalizedRequest,
    options: StreamOptions = {},
  ): AsyncGenerator<Delta, void, undefined> {
    const events = this.#http.sse({
      method: 'POST',
      path: this.#options.chatPath?.(request.modelId) ?? '/chat/completions',
      ...(this.#options.query ? { query: this.#options.query } : {}),
      body: this.toWire(request),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    let started = false;
    let stopReason: StopReason = 'stop';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    /** Tool calls stream by array index; the id only arrives on the first one. */
    const openCalls = new Map<number, string>();

    for await (const event of events) {
      if (event.data === '[DONE]') break;
      if (event.data.length === 0) continue;

      const chunk = JSON.parse(event.data) as OpenAiChunk;
      if (chunk.error) throw toProviderError(this.adapterId, chunk.error);

      if (!started) {
        started = true;
        yield {
          kind: 'start',
          model: {
            vendorId: this.vendorId,
            modelId: request.modelId,
            ...(chunk.model ? { version: chunk.model } : {}),
          },
          ...(chunk.id ? { providerRequestId: chunk.id } : {}),
        };
      }

      if (chunk.usage) usage = mergeUsage(usage, chunk.usage);

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta ?? {};
      // DeepSeek calls it `reasoning_content`, OpenRouter `reasoning`. Same thing.
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) yield { kind: 'reasoning', text: reasoning };
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        yield { kind: 'text', text: delta.content };
      }

      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        let callId = openCalls.get(index);
        if (callId === undefined) {
          callId = call.id ?? `call_${String(index)}`;
          openCalls.set(index, callId);
          yield { kind: 'tool_call_start', callId, name: call.function?.name ?? '' };
        }
        const fragment = call.function?.arguments;
        if (fragment) yield { kind: 'tool_call_delta', callId, argumentsJson: fragment };
      }

      if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason);
    }

    // Every open call is closed before the end, in the order they opened, so
    // the stream is well-formed even though this API never says "call over".
    for (const callId of openCalls.values()) yield { kind: 'tool_call_end', callId };

    if (!started) {
      throw new ProviderError(this.adapterId, 502, 'the stream ended before it began', {
        retryable: true,
      });
    }
    yield { kind: 'end', stopReason, usage };
  }

  /** The normalized request in chat-completions shape. Public for the recorder. */
  toWire(request: NormalizedRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.modelId,
      stream: true,
      messages: toWireMessages(request.messages, request.system),
    };

    body[this.#options.maxTokensField ?? 'max_tokens'] = request.maxOutputTokens;

    if (this.#options.includeUsage !== false) body['stream_options'] = { include_usage: true };
    if (request.tools?.length) body['tools'] = request.tools.map(toWireTool);
    if (request.toolChoice) body['tool_choice'] = toWireToolChoice(request.toolChoice);
    if (request.stopSequences?.length) body['stop'] = [...request.stopSequences];
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.topP !== undefined) body['top_p'] = request.topP;
    if (request.seed !== undefined) body['seed'] = request.seed;
    if (request.responseFormat?.kind === 'json_schema') {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: {
          name: request.responseFormat.name,
          schema: request.responseFormat.schema,
          strict: true,
        },
      };
    }

    return body;
  }

  async #fetchCatalogue(options: ListModelsOptions): Promise<ModelDescriptor[]> {
    const response = await this.#http.json<{ data?: OpenAiModelRow[] }>({
      method: 'GET',
      path: this.#options.modelsPath ?? '/models',
      ...(this.#options.query ? { query: this.#options.query } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    return (response.data ?? []).map((row) => this.#toDescriptor(row));
  }

  #toDescriptor(row: OpenAiModelRow): ModelDescriptor {
    const base = this.#describeUnlisted(row.id);
    return {
      ...base,
      displayName: row.name ?? row.id,
      ...(row.context_length ? { contextWindowTokens: row.context_length } : {}),
      ...(row.top_provider?.max_completion_tokens
        ? { maxOutputTokens: row.top_provider.max_completion_tokens }
        : {}),
      pricing: this.#options.modelPricing?.[row.id] ?? perMillion(row.pricing) ?? base.pricing,
    };
  }

  #describeUnlisted(modelId: string): ModelDescriptor {
    return {
      vendorId: this.vendorId,
      modelId,
      displayName: modelId,
      contextWindowTokens: this.#options.defaultContextWindowTokens ?? 128_000,
      maxOutputTokens: this.#options.defaultMaxOutputTokens ?? 16_384,
      capabilities: this.#options.defaultCapabilities ?? OPENAI_DEFAULT_CAPABILITIES,
      pricing: this.#options.modelPricing?.[modelId] ?? this.#options.defaultPricing ?? null,
      local: this.#options.local ?? false,
    };
  }
}

/**
 * OpenRouter is the one endpoint that publishes prices, per token as strings.
 * Anything else yields `null` — unknown, which is not the same as free.
 */
function perMillion(pricing: OpenAiModelRow['pricing']): ModelPricing | null {
  if (!pricing) return null;
  const input = Number(pricing.prompt);
  const output = Number(pricing.completion);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;

  const cached = Number(pricing.input_cache_read);
  const write = Number(pricing.input_cache_write);
  return {
    inputPerMTokUsd: input * 1_000_000,
    outputPerMTokUsd: output * 1_000_000,
    ...(Number.isFinite(cached) ? { cachedInputPerMTokUsd: cached * 1_000_000 } : {}),
    ...(Number.isFinite(write) ? { cacheWritePerMTokUsd: write * 1_000_000 } : {}),
  };
}

/**
 * Flattens Sheep's messages into the chat-completions list.
 *
 * Not one-to-one: a system prompt becomes a leading message, and a tool result
 * becomes its own `role: 'tool'` entry rather than a block inside a user turn.
 * One Sheep message can therefore produce several.
 */
function toWireMessages(
  messages: readonly NormalizedMessage[],
  system: string | null,
): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = [];
  if (system !== null) wire.push({ role: 'system', content: system });

  for (const message of messages) {
    const content: Record<string, unknown>[] = [];
    const toolCalls: Record<string, unknown>[] = [];

    for (const part of message.content) {
      switch (part.kind) {
        case 'text':
          content.push({ type: 'text', text: part.text });
          break;
        case 'image':
          content.push({
            type: 'image_url',
            image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` },
          });
          break;
        case 'tool_use':
          toolCalls.push({
            id: part.callId,
            type: 'function',
            function: { name: part.name, arguments: part.argumentsJson },
          });
          break;
        case 'tool_result':
          // Flushed immediately: a tool result must be its own message, and
          // must follow the assistant turn that asked for it.
          wire.push({ role: 'tool', tool_call_id: part.callId, content: part.content });
          break;
      }
    }

    if (content.length > 0 || toolCalls.length > 0) {
      wire.push({
        role: message.role,
        ...(content.length > 0
          ? {
              content:
                content.length === 1 && content[0]?.['type'] === 'text'
                  ? content[0]['text']
                  : content,
            }
          : { content: null }),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  return wire;
}

function toWireTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

function toWireToolChoice(choice: NonNullable<NormalizedRequest['toolChoice']>): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function mergeUsage(usage: TokenUsage, reported: OpenAiUsage): TokenUsage {
  const cached = reported.prompt_tokens_details?.cached_tokens;
  const reasoning = reported.completion_tokens_details?.reasoning_tokens;
  // Cached tokens are *included* in prompt_tokens here, unlike Anthropic; they
  // are subtracted out so the two never bill the same token twice.
  const prompt = reported.prompt_tokens ?? usage.inputTokens;
  return {
    inputTokens: cached ? Math.max(0, prompt - cached) : prompt,
    outputTokens: reported.completion_tokens ?? usage.outputTokens,
    ...(cached ? { cachedInputTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  };
}

function toProviderError(adapterId: string, error: { message?: string; type?: string }): Error {
  return new ProviderError(adapterId, 500, error.message ?? 'stream error', {
    ...(error.type === undefined ? {} : { providerType: error.type }),
  });
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAiChunk {
  id?: string;
  model?: string;
  usage?: OpenAiUsage;
  error?: { message?: string; type?: string };
  choices?: {
    delta?: {
      content?: string | null;
      reasoning?: string;
      reasoning_content?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
}

interface OpenAiModelRow {
  id: string;
  name?: string;
  context_length?: number;
  top_provider?: { max_completion_tokens?: number };
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

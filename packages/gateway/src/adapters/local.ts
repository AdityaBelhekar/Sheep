import type { AdapterId, ListModelsOptions, ModelAdapter, StreamOptions } from '../adapter';
import type { Delta, StopReason, TokenUsage } from '../delta';
import {
  capabilities,
  FREE_PRICING,
  type CapabilityFlags,
  type ModelDescriptor,
} from '../descriptor';
import { HttpClient, type FetchLike } from '../http/client';
import type { NormalizedMessage, NormalizedRequest, ToolSpec } from '../request';
import { OpenAiCompatibleAdapter } from './openai';

/**
 * Models running on this machine.
 *
 * Three runtimes, two protocols: llama.cpp's server and LM Studio both serve
 * the OpenAI dialect, so they are configurations of the Phase 13 adapter rather
 * than new code. Ollama gets its own class because its native API is the one
 * that knows what is installed — the catalogue is the whole reason a local
 * provider is discoverable at all.
 *
 * Everything here is priced at zero rather than unknown: a local model really
 * does cost nothing per token, and the budget governor should let it run
 * unmetered rather than refuse it for having no price.
 */

export const LOCAL_HOST = '127.0.0.1';

export const OLLAMA_BASE_URL = `http://${LOCAL_HOST}:11434`;
export const LLAMA_CPP_BASE_URL = `http://${LOCAL_HOST}:8080/v1`;
export const LM_STUDIO_BASE_URL = `http://${LOCAL_HOST}:1234/v1`;

/**
 * What a local model is assumed to do.
 *
 * Tool use and vision depend on the weights, not the server, and no local
 * runtime reports which — so the flags are permissive and a model that cannot
 * really use a tool will simply not call one. Refusing tools for every local
 * model would be wrong far more often.
 */
export const LOCAL_CAPABILITIES: CapabilityFlags = capabilities({
  streaming: true,
  systemPrompt: true,
  tools: true,
  vision: true,
  reasoning: true,
  jsonSchemaOutput: true,
  stopSequences: true,
  temperature: true,
  topP: true,
  seed: true,
});

/** Local runtimes are undersized on context by default until asked. */
const DEFAULT_LOCAL_CONTEXT_TOKENS = 8_192;

export interface OllamaAdapterOptions {
  readonly adapterId?: AdapterId;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  /** Ollama publishes no context length in the model list; this is the floor. */
  readonly defaultContextWindowTokens?: number;
}

export class OllamaAdapter implements ModelAdapter {
  readonly adapterId: AdapterId;
  readonly vendorId = 'ollama';
  readonly #options: OllamaAdapterOptions;
  readonly #http: HttpClient;

  constructor(options: OllamaAdapterOptions = {}) {
    this.adapterId = options.adapterId ?? 'ollama';
    this.#options = options;
    this.#http = new HttpClient({
      adapterId: this.adapterId,
      baseUrl: options.baseUrl ?? OLLAMA_BASE_URL,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      // A cold model is loaded from disk on first use; that is slow, not stuck.
      timeoutMs: options.timeoutMs ?? 600_000,
    });
  }

  async listModels(options: ListModelsOptions = {}): Promise<ModelDescriptor[]> {
    const response = await this.#http.json<{ models?: OllamaTag[] }>({
      method: 'GET',
      path: '/api/tags',
      ...(options.signal ? { signal: options.signal } : {}),
    });

    return (response.models ?? []).map((row) => this.#toDescriptor(row));
  }

  async describeModel(
    modelId: string,
    options: ListModelsOptions = {},
  ): Promise<ModelDescriptor | null> {
    const listed = (await this.listModels(options)).find((entry) => entry.modelId === modelId);
    if (!listed) return null;

    // `/api/show` is the only place the real context length is published, and
    // it costs a call per model — so it is asked for one model, not the list.
    try {
      const shown = await this.#http.json<OllamaShow>({
        method: 'POST',
        path: '/api/show',
        body: { model: modelId },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const context = contextLengthOf(shown);
      return context ? { ...listed, contextWindowTokens: context } : listed;
    } catch {
      // An older Ollama without the endpoint is not a reason to refuse the model.
      return listed;
    }
  }

  async *stream(
    request: NormalizedRequest,
    options: StreamOptions = {},
  ): AsyncGenerator<Delta, void, undefined> {
    const rows = this.#http.jsonLines<OllamaChunk>({
      method: 'POST',
      path: '/api/chat',
      body: this.toWire(request),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    let started = false;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = 'stop';
    let callIndex = 0;

    for await (const chunk of rows) {
      if (chunk.error) throw new Error(`ollama: ${chunk.error}`);

      if (!started) {
        started = true;
        yield {
          kind: 'start',
          model: {
            vendorId: this.vendorId,
            modelId: request.modelId,
            ...(chunk.model ? { version: chunk.model } : {}),
          },
        };
      }

      const message = chunk.message;
      if (message?.thinking) yield { kind: 'reasoning', text: message.thinking };
      if (message?.content) yield { kind: 'text', text: message.content };

      for (const call of message?.tool_calls ?? []) {
        const callId = `${call.function.name}_${String(callIndex)}`;
        callIndex += 1;
        yield { kind: 'tool_call_start', callId, name: call.function.name };
        yield {
          kind: 'tool_call_delta',
          callId,
          argumentsJson: JSON.stringify(call.function.arguments ?? {}),
        };
        yield { kind: 'tool_call_end', callId };
      }

      if (chunk.done) {
        usage = {
          inputTokens: chunk.prompt_eval_count ?? 0,
          outputTokens: chunk.eval_count ?? 0,
        };
        if (chunk.done_reason === 'length') stopReason = 'max_tokens';
        else if (callIndex > 0) stopReason = 'tool_use';
      }
    }

    if (started) yield { kind: 'end', stopReason, usage };
  }

  /** The normalized request in Ollama's shape. Public for the recorder. */
  toWire(request: NormalizedRequest): Record<string, unknown> {
    const modelOptions: Record<string, unknown> = { num_predict: request.maxOutputTokens };
    if (request.temperature !== undefined) modelOptions['temperature'] = request.temperature;
    if (request.topP !== undefined) modelOptions['top_p'] = request.topP;
    if (request.seed !== undefined) modelOptions['seed'] = request.seed;
    if (request.stopSequences?.length) modelOptions['stop'] = [...request.stopSequences];

    const body: Record<string, unknown> = {
      model: request.modelId,
      stream: true,
      messages: toOllamaMessages(request.messages, request.system),
      options: modelOptions,
    };

    if (request.tools?.length) body['tools'] = request.tools.map(toOllamaTool);
    if (request.responseFormat?.kind === 'json_schema') {
      body['format'] = request.responseFormat.schema;
    }
    return body;
  }

  #toDescriptor(row: OllamaTag): ModelDescriptor {
    return {
      vendorId: this.vendorId,
      modelId: row.model ?? row.name,
      displayName: row.name,
      contextWindowTokens: this.#options.defaultContextWindowTokens ?? DEFAULT_LOCAL_CONTEXT_TOKENS,
      maxOutputTokens: 4_096,
      capabilities: LOCAL_CAPABILITIES,
      // Free, which is not the same as unknown: this one may run under a cap.
      pricing: FREE_PRICING,
      local: true,
    };
  }
}

/** llama.cpp's own server: the OpenAI dialect, on this machine, with no key. */
export function createLlamaCppAdapter(
  options: { adapterId?: AdapterId; baseUrl?: string; fetch?: FetchLike } = {},
): OpenAiCompatibleAdapter {
  return new OpenAiCompatibleAdapter({
    adapterId: options.adapterId ?? 'llamacpp',
    vendorId: 'llamacpp',
    baseUrl: options.baseUrl ?? LLAMA_CPP_BASE_URL,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    defaultCapabilities: LOCAL_CAPABILITIES,
    defaultContextWindowTokens: DEFAULT_LOCAL_CONTEXT_TOKENS,
    local: true,
    modelPricing: {},
  });
}

export function createLmStudioAdapter(
  options: { adapterId?: AdapterId; baseUrl?: string; fetch?: FetchLike } = {},
): OpenAiCompatibleAdapter {
  return new OpenAiCompatibleAdapter({
    adapterId: options.adapterId ?? 'lmstudio',
    vendorId: 'lmstudio',
    baseUrl: options.baseUrl ?? LM_STUDIO_BASE_URL,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    defaultCapabilities: LOCAL_CAPABILITIES,
    defaultContextWindowTokens: DEFAULT_LOCAL_CONTEXT_TOKENS,
    local: true,
    modelPricing: {},
  });
}

export const LOCAL_PROVIDERS = {
  ollama: {
    displayName: 'Ollama',
    baseUrl: OLLAMA_BASE_URL,
    probePath: '/api/tags',
    install: 'https://ollama.com/download',
  },
  llamacpp: {
    displayName: 'llama.cpp server',
    baseUrl: LLAMA_CPP_BASE_URL,
    probePath: '/models',
    install: 'https://github.com/ggml-org/llama.cpp',
  },
  lmstudio: {
    displayName: 'LM Studio',
    baseUrl: LM_STUDIO_BASE_URL,
    probePath: '/models',
    install: 'https://lmstudio.ai',
  },
} as const;

export type LocalProviderId = keyof typeof LOCAL_PROVIDERS;

/**
 * What a probe found.
 *
 * `absent` is a first-class result, not an error: no local runtime is installed
 * on most machines, including the one Sheep is being built on, and a UI that
 * shows a red failure for the normal case is a UI that trains people to ignore
 * red. `unreachable` is the different, rarer thing — something is listening and
 * answering wrongly, which the user does want to see.
 */
export interface LocalProviderStatus {
  readonly id: LocalProviderId;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly status: 'running' | 'absent' | 'unreachable';
  readonly models: readonly string[];
  /** Where to get it, when it is not there. */
  readonly install: string;
  readonly detail?: string;
}

export interface DetectOptions {
  readonly fetch?: FetchLike;
  /** Short: this runs on a settings screen and must not make it feel stuck. */
  readonly timeoutMs?: number;
  readonly only?: readonly LocalProviderId[];
  readonly signal?: AbortSignal;
}

/**
 * Probes each local runtime in parallel and reports what is there.
 *
 * Never throws: the whole point is to answer "what can this machine run" on a
 * machine where the answer is "nothing", and a rejected promise is not an
 * answer a settings screen can render.
 */
export async function detectLocalProviders(
  options: DetectOptions = {},
): Promise<LocalProviderStatus[]> {
  const ids = options.only ?? (Object.keys(LOCAL_PROVIDERS) as LocalProviderId[]);
  return await Promise.all(ids.map((id) => probeLocalProvider(id, options)));
}

export async function probeLocalProvider(
  id: LocalProviderId,
  options: DetectOptions = {},
): Promise<LocalProviderStatus> {
  const provider = LOCAL_PROVIDERS[id];
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base: Omit<LocalProviderStatus, 'status' | 'models'> = {
    id,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    install: provider.install,
  };

  try {
    const response = await doFetch(`${provider.baseUrl}${provider.probePath}`, {
      method: 'GET',
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 1_500)])
        : AbortSignal.timeout(options.timeoutMs ?? 1_500),
    });

    if (!response.ok) {
      return {
        ...base,
        status: 'unreachable',
        models: [],
        detail: `responded ${String(response.status)}`,
      };
    }
    return { ...base, status: 'running', models: modelNamesFrom(await response.json()) };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    // Nothing listening on the port is the ordinary case, not a fault.
    return { ...base, status: 'absent', models: [], detail: reason };
  }
}

/** Ollama answers `{models:[{name}]}`, the OpenAI dialect `{data:[{id}]}`. */
function modelNamesFrom(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const record = payload as {
    models?: { name?: string; model?: string }[];
    data?: { id?: string }[];
  };
  if (Array.isArray(record.models)) {
    return record.models
      .map((row) => row.model ?? row.name ?? '')
      .filter((name) => name.length > 0);
  }
  if (Array.isArray(record.data)) {
    return record.data.map((row) => row.id ?? '').filter((id) => id.length > 0);
  }
  return [];
}

/** Builds the adapter for whatever a probe found running. */
export function createLocalAdapter(
  id: LocalProviderId,
  options: { adapterId?: AdapterId; baseUrl?: string; fetch?: FetchLike } = {},
): ModelAdapter {
  switch (id) {
    case 'ollama':
      return new OllamaAdapter(options);
    case 'llamacpp':
      return createLlamaCppAdapter(options);
    case 'lmstudio':
      return createLmStudioAdapter(options);
  }
}

function toOllamaMessages(
  messages: readonly NormalizedMessage[],
  system: string | null,
): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = [];
  if (system !== null) wire.push({ role: 'system', content: system });

  for (const message of messages) {
    let text = '';
    const images: string[] = [];
    const toolCalls: Record<string, unknown>[] = [];

    for (const part of message.content) {
      switch (part.kind) {
        case 'text':
          text += part.text;
          break;
        case 'image':
          // Ollama takes bare base64 with no data: prefix and no media type.
          images.push(part.dataBase64);
          break;
        case 'tool_use':
          toolCalls.push({
            function: { name: part.name, arguments: safeParse(part.argumentsJson) },
          });
          break;
        case 'tool_result':
          wire.push({ role: 'tool', content: part.content });
          break;
      }
    }

    if (text.length > 0 || images.length > 0 || toolCalls.length > 0) {
      wire.push({
        role: message.role,
        content: text,
        ...(images.length > 0 ? { images } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  return wire;
}

function toOllamaTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** `/api/show` keys the context length by architecture: `llama.context_length`. */
function contextLengthOf(shown: OllamaShow): number | undefined {
  const info = shown.model_info ?? {};
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && typeof value === 'number') return value;
  }
  return undefined;
}

interface OllamaTag {
  name: string;
  model?: string;
}

interface OllamaShow {
  model_info?: Record<string, unknown>;
}

interface OllamaChunk {
  model?: string;
  error?: string;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { function: { name: string; arguments?: unknown } }[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

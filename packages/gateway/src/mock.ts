import type { AdapterId, ListModelsOptions, ModelAdapter, StreamOptions } from './adapter';
import type { Delta, StopReason, TokenUsage } from './delta';
import {
  capabilities,
  MODEL_CAPABILITIES,
  type CapabilityFlags,
  type ModelDescriptor,
} from './descriptor';
import { StreamCancelledError } from './errors';
import type { NormalizedRequest } from './request';

/**
 * A scripted adapter, for tests and for developing against the gateway with no
 * key and no network.
 *
 * It is deliberately part of the shipped package rather than a test fixture:
 * Phase 16 needs a provider it can make fail on demand, and the resilience
 * layer is only trustworthy if the thing that proved it is the thing that ships.
 * Exported from `@sheep/gateway/mock` so nothing reaches it by accident.
 */

/** Every capability on — the default a mock model claims. */
export const ALL_CAPABILITIES: CapabilityFlags = capabilities(
  Object.fromEntries(MODEL_CAPABILITIES.map((name) => [name, true])) as CapabilityFlags,
);

export const MOCK_VENDOR_ID = 'mock';
export const MOCK_ADAPTER_ID = 'mock';
export const MOCK_MODEL_ID = 'mock-1';

/** A descriptor with sane defaults; override only what a test cares about. */
export function mockDescriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    vendorId: MOCK_VENDOR_ID,
    modelId: MOCK_MODEL_ID,
    displayName: 'Mock 1',
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    capabilities: ALL_CAPABILITIES,
    pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
    local: false,
    ...overrides,
  };
}

export interface MockToolCall {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
  /** Characters per fragment. Omit to send the arguments whole. */
  readonly chunkSize?: number;
}

/** What one call should produce. */
export interface MockScript {
  /** Hand-built deltas, replacing everything else except `throwAfter`. */
  readonly deltas?: readonly Delta[];
  readonly text?: string;
  readonly reasoning?: string;
  readonly toolCalls?: readonly MockToolCall[];
  /** Characters per text delta. Default 8, so streaming is actually exercised. */
  readonly chunkSize?: number;
  readonly usage?: Partial<TokenUsage>;
  readonly stopReason?: StopReason;
  readonly version?: string;
  /** Throw after this many deltas have been yielded — a mid-stream failure. */
  readonly throwAfter?: number;
  readonly error?: Error;
}

export type MockResponder = (
  request: NormalizedRequest,
  callIndex: number,
) => MockScript | Promise<MockScript>;

export interface MockAdapterOptions {
  readonly adapterId?: AdapterId;
  readonly vendorId?: string;
  readonly models?: readonly ModelDescriptor[];
  /** A fixed script, or one chosen per call. Default: a short greeting. */
  readonly respond?: MockScript | MockResponder;
}

const DEFAULT_SCRIPT: MockScript = { text: 'Hello from the mock adapter.' };

export class MockAdapter implements ModelAdapter {
  readonly adapterId: AdapterId;
  readonly vendorId: string;
  /** Every request this adapter was handed, in order. */
  readonly requests: NormalizedRequest[] = [];
  #closed = false;
  readonly #models: readonly ModelDescriptor[];
  readonly #respond: MockScript | MockResponder;

  constructor(options: MockAdapterOptions = {}) {
    this.adapterId = options.adapterId ?? MOCK_ADAPTER_ID;
    this.vendorId = options.vendorId ?? MOCK_VENDOR_ID;
    this.#models = options.models ?? [
      mockDescriptor({ vendorId: options.vendorId ?? MOCK_VENDOR_ID }),
    ];
    this.#respond = options.respond ?? DEFAULT_SCRIPT;
  }

  get closed(): boolean {
    return this.#closed;
  }

  listModels(_options?: ListModelsOptions): Promise<ModelDescriptor[]> {
    return Promise.resolve([...this.#models]);
  }

  describeModel(modelId: string, _options?: ListModelsOptions): Promise<ModelDescriptor | null> {
    return Promise.resolve(this.#models.find((model) => model.modelId === modelId) ?? null);
  }

  async *stream(
    request: NormalizedRequest,
    options: StreamOptions = {},
  ): AsyncGenerator<Delta, void, undefined> {
    const callIndex = this.requests.length;
    this.requests.push(request);

    const script =
      typeof this.#respond === 'function' ? await this.#respond(request, callIndex) : this.#respond;

    let yielded = 0;
    for (const delta of scriptToDeltas(script, request, this.vendorId)) {
      if (options.signal?.aborted) throw new StreamCancelledError(this.adapterId);
      if (script.throwAfter !== undefined && yielded >= script.throwAfter) {
        throw script.error ?? new Error('mock adapter failure');
      }
      yielded += 1;
      yield delta;
      // A real stream always suspends between deltas; so does this one, or a
      // caller that cancels mid-stream would never get a turn to do it.
      await Promise.resolve();
    }

    if (script.throwAfter !== undefined && yielded >= script.throwAfter) {
      throw script.error ?? new Error('mock adapter failure');
    }
  }

  countInputTokens(request: NormalizedRequest): Promise<number> {
    return Promise.resolve(estimateTokens(request));
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}

/** Convenience: a registered-ready adapter with one scripted reply. */
export function mockAdapter(options: MockAdapterOptions = {}): MockAdapter {
  return new MockAdapter(options);
}

function scriptToDeltas(script: MockScript, request: NormalizedRequest, vendorId: string): Delta[] {
  if (script.deltas) return [...script.deltas];

  const chunkSize = script.chunkSize ?? 8;
  const text = script.text ?? '';
  const deltas: Delta[] = [
    {
      kind: 'start',
      model: {
        vendorId,
        modelId: request.modelId,
        ...(script.version === undefined ? {} : { version: script.version }),
      },
    },
  ];

  for (const chunk of chunked(script.reasoning ?? '', chunkSize)) {
    deltas.push({ kind: 'reasoning', text: chunk });
  }
  for (const chunk of chunked(text, chunkSize)) {
    deltas.push({ kind: 'text', text: chunk });
  }
  for (const call of script.toolCalls ?? []) {
    deltas.push({ kind: 'tool_call_start', callId: call.callId, name: call.name });
    for (const chunk of chunked(call.argumentsJson, call.chunkSize ?? call.argumentsJson.length)) {
      deltas.push({ kind: 'tool_call_delta', callId: call.callId, argumentsJson: chunk });
    }
    deltas.push({ kind: 'tool_call_end', callId: call.callId });
  }

  const hasToolCalls = (script.toolCalls?.length ?? 0) > 0;
  deltas.push({
    kind: 'end',
    stopReason: script.stopReason ?? (hasToolCalls ? 'tool_use' : 'stop'),
    usage: {
      inputTokens: script.usage?.inputTokens ?? estimateTokens(request),
      outputTokens: script.usage?.outputTokens ?? approximateTokens(text),
      ...(script.usage?.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: script.usage.cachedInputTokens }),
      ...(script.usage?.cacheWriteTokens === undefined
        ? {}
        : { cacheWriteTokens: script.usage.cacheWriteTokens }),
      ...(script.usage?.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: script.usage.reasoningTokens }),
    },
  });

  return deltas;
}

function chunked(text: string, size: number): string[] {
  if (text.length === 0) return [];
  const step = Math.max(1, size);
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += step) {
    chunks.push(text.slice(index, index + step));
  }
  return chunks;
}

/** Four characters per token: wrong for every tokenizer, close enough for a mock. */
function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateTokens(request: NormalizedRequest): number {
  let characters = request.system?.length ?? 0;
  for (const message of request.messages) {
    for (const part of message.content) {
      switch (part.kind) {
        case 'text':
          characters += part.text.length;
          break;
        case 'tool_use':
          characters += part.name.length + part.argumentsJson.length;
          break;
        case 'tool_result':
          characters += part.content.length;
          break;
        case 'image':
          characters += part.dataBase64.length;
          break;
      }
    }
  }
  return Math.ceil(characters / 4);
}

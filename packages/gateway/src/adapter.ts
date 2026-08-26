import { slugSchema, type VendorId } from '@sheep/core';
import type { z } from 'zod';
import type { Delta } from './delta';
import type { ModelDescriptor } from './descriptor';
import type { NormalizedRequest } from './request';

/** Registry key for one adapter instance: `anthropic`, `ollama`, `openai-compatible`. */
export const adapterIdSchema = slugSchema;
export type AdapterId = z.infer<typeof adapterIdSchema>;

export interface StreamOptions {
  /** Cancels the call. Adapters must abort the underlying request, not just stop reading. */
  readonly signal?: AbortSignal;
}

export interface ListModelsOptions {
  /** Skip any cached catalogue and ask the provider again. */
  readonly refresh?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Everything a provider must do to be a Sheep participant.
 *
 * The surface is small on purpose: the adapter's whole job is translation, and
 * every cross-cutting concern lives above it. Rate limiting, retries and the
 * circuit breaker are Phase 16's wrapper; cost is computed from the descriptor
 * and reported usage, never by the adapter; validation is the registry's.
 *
 * `stream` is the only way to run a model. There is no `complete()` — a
 * non-streaming provider yields one text delta and an end — because two entry
 * points would mean two code paths for cancellation and partial persistence.
 */
export interface ModelAdapter {
  readonly adapterId: AdapterId;
  /**
   * Whose weights these are.
   *
   * Not derivable from `adapterId`: the OpenAI-compatible adapter (Phase 13) is
   * one implementation registered many times, and P1's independence check
   * turns on the vendor, not the code path.
   */
  readonly vendorId: VendorId;

  /** The catalogue this connection can reach. May hit the network. */
  listModels(options?: ListModelsOptions): Promise<ModelDescriptor[]>;

  /** One model, or `null` if this connection does not serve it. */
  describeModel(modelId: string, options?: ListModelsOptions): Promise<ModelDescriptor | null>;

  /**
   * Run the model.
   *
   * Yields `start` first and `end` last, and throws rather than yielding an
   * error delta — a failure the caller can ignore by not reading the stream is
   * a failure that gets ignored.
   */
  stream(request: NormalizedRequest, options?: StreamOptions): AsyncIterable<Delta>;

  /**
   * Count the tokens a request will use, when the provider offers that.
   *
   * Optional because most do not; Phase 17 falls back to a heuristic and marks
   * the result `estimated` either way.
   */
  countInputTokens?(request: NormalizedRequest, options?: StreamOptions): Promise<number>;

  /** Release sockets and timers. Called when a connection is removed. */
  close?(): Promise<void>;
}

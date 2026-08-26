import type { AdapterId, ListModelsOptions, ModelAdapter, StreamOptions } from '../adapter';
import type { Delta, StopReason, TokenUsage } from '../delta';
import type { ModelDescriptor } from '../descriptor';
import { RateLimitedError } from '../errors';
import type { NormalizedRequest } from '../request';
import {
  isRetryable,
  retryDelayMs,
  sleep as realSleep,
  type BackoffOptions,
  type Sleep,
} from './backoff';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker';
import { ExchangeRecorder, type BlobPut, type ExchangeRecord } from './recorder';
import { TokenBucket, type TokenBucketOptions } from './token-bucket';

/**
 * One wrapper, every provider.
 *
 * The adapters below this know nothing about limits, retries or breakers, and
 * that is the arrangement worth defending: a resilience bug is fixed once, a
 * new adapter inherits the behaviour by existing, and the policy is visible in
 * one file instead of being spread across six vendors' idioms.
 *
 * The one rule that shapes everything here: a stream can only be retried
 * *before its first delta*. After that the caller has already seen text, and a
 * retry would replay it — so a mid-stream failure is recorded with whatever
 * arrived and raised, rather than silently duplicating output.
 */

export interface ResilienceOptions {
  readonly rateLimit?: TokenBucketOptions;
  readonly circuit?: CircuitBreakerOptions;
  readonly retry?: RetryOptions;
  /** Where exchanges are kept. Omit to run without recording. */
  readonly blobs?: BlobPut;
  /** Called once per attempt sequence, after the stream ends or fails. */
  readonly onExchange?: (record: ExchangeRecord) => void;
  readonly sleep?: Sleep;
  readonly now?: () => Date;
}

export interface RetryOptions extends BackoffOptions {
  /** Total attempts, not extra ones. 1 disables retrying. */
  readonly maxAttempts?: number;
  /** How long to wait for a rate-limit slot before giving up. */
  readonly maxRateLimitWaitMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * Wraps an adapter without changing what it is.
 *
 * Returns a `ModelAdapter`, so the registry, the capability checks and the
 * stream guard all still apply, and a wrapped adapter can be registered
 * anywhere an unwrapped one can.
 */
export function withResilience(
  adapter: ModelAdapter,
  options: ResilienceOptions = {},
): ResilientAdapter {
  return new ResilientAdapter(adapter, options);
}

export class ResilientAdapter implements ModelAdapter {
  readonly adapterId: AdapterId;
  readonly vendorId: string;
  readonly breaker: CircuitBreaker;
  readonly bucket: TokenBucket | undefined;
  readonly #inner: ModelAdapter;
  readonly #options: ResilienceOptions;
  readonly #recorder: ExchangeRecorder | undefined;
  readonly #sleep: Sleep;
  readonly #now: () => Date;

  constructor(inner: ModelAdapter, options: ResilienceOptions = {}) {
    this.#inner = inner;
    this.#options = options;
    this.adapterId = inner.adapterId;
    this.vendorId = inner.vendorId;
    this.breaker = new CircuitBreaker(inner.adapterId, options.circuit);
    this.bucket = options.rateLimit ? new TokenBucket(options.rateLimit) : undefined;
    this.#recorder = options.blobs
      ? new ExchangeRecorder(options.blobs, options.now ? { now: options.now } : {})
      : undefined;
    this.#sleep = options.sleep ?? realSleep;
    this.#now = options.now ?? (() => new Date());
  }

  listModels(options?: ListModelsOptions): Promise<ModelDescriptor[]> {
    return this.#inner.listModels(options);
  }

  describeModel(modelId: string, options?: ListModelsOptions): Promise<ModelDescriptor | null> {
    return this.#inner.describeModel(modelId, options);
  }

  countInputTokens(request: NormalizedRequest, options?: StreamOptions): Promise<number> {
    return this.#inner.countInputTokens?.(request, options) ?? Promise.resolve(0);
  }

  close(): Promise<void> {
    return this.#inner.close?.() ?? Promise.resolve();
  }

  async *stream(
    request: NormalizedRequest,
    options: StreamOptions = {},
  ): AsyncGenerator<Delta, void, undefined> {
    const maxAttempts = this.#options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const requestHash = this.#recordRequest(request);
    const startedAt = this.#now().toISOString();

    const deltas: Delta[] = [];
    let usage: TokenUsage | null = null;
    let stopReason: StopReason | null = null;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      let yielded = 0;

      try {
        await this.#acquireSlot(options.signal);
        this.breaker.assertAllowed();

        for await (const delta of this.#inner.stream(request, options)) {
          yielded += 1;
          deltas.push(delta);
          if (delta.kind === 'end') {
            usage = delta.usage;
            stopReason = delta.stopReason;
          } else if (delta.kind === 'usage') {
            usage = delta.usage;
          }
          yield delta;
        }

        this.breaker.onSuccess();
        this.#finish({ request, requestHash, startedAt, deltas, usage, stopReason, attempt });
        return;
      } catch (error) {
        // A local refusal never reached the provider, so it is neither the
        // provider's fault nor a reason to spend a rate-limit token.
        const reachedProvider = !(error instanceof RateLimitedError);
        if (reachedProvider) this.breaker.onFailure();
        else this.bucket?.refund();

        const canRetry =
          yielded === 0 && attempt < maxAttempts && isRetryable(error) && !options.signal?.aborted;

        if (!canRetry) {
          this.#finish({
            request,
            requestHash,
            startedAt,
            deltas,
            usage,
            stopReason,
            attempt,
            error,
          });
          throw error;
        }

        // Nothing was yielded, so nothing the caller saw is being replayed.
        deltas.length = 0;
        await this.#sleep(retryDelayMs(error, attempt, this.#options.retry ?? {}), options.signal);
      }
    }
  }

  /**
   * Waits for a rate-limit slot, rather than failing on a full bucket.
   *
   * Waiting is right for a queue of model calls and wrong for an interactive
   * one, so there is a ceiling: past `maxRateLimitWaitMs` the call is refused
   * with the wait it would have needed, which the UI can show.
   */
  async #acquireSlot(signal: AbortSignal | undefined): Promise<void> {
    const bucket = this.bucket;
    if (!bucket) return;

    const maxWait = this.#options.retry?.maxRateLimitWaitMs ?? DEFAULT_MAX_RATE_LIMIT_WAIT_MS;
    for (;;) {
      if (bucket.tryTake()) return;
      const waitMs = bucket.msUntilAvailable();
      if (waitMs > maxWait) throw new RateLimitedError(this.adapterId, waitMs);
      await this.#sleep(waitMs, signal);
    }
  }

  #recordRequest(request: NormalizedRequest): string | undefined {
    if (!this.#recorder) return undefined;
    const wire = (this.#inner as { toWire?: (r: NormalizedRequest) => unknown }).toWire?.(request);
    return this.#recorder.putRequest({
      adapterId: this.adapterId,
      vendorId: this.vendorId,
      request,
      ...(wire === undefined ? {} : { wire }),
    });
  }

  #finish(context: {
    request: NormalizedRequest;
    requestHash: string | undefined;
    startedAt: string;
    deltas: readonly Delta[];
    usage: TokenUsage | null;
    stopReason: StopReason | null;
    attempt: number;
    error?: unknown;
  }): void {
    const recorder = this.#recorder;
    if (!recorder || context.requestHash === undefined) return;

    const record: ExchangeRecord = {
      adapterId: this.adapterId,
      modelId: context.request.modelId,
      requestHash: context.requestHash,
      // Recorded even when the stream died halfway: those tokens were paid for.
      transcriptHash: recorder.putTranscript(context.deltas),
      startedAt: context.startedAt,
      finishedAt: this.#now().toISOString(),
      attempts: context.attempt,
      deltaCount: context.deltas.length,
      usage: context.usage,
      stopReason: context.stopReason,
      partial: context.error !== undefined,
      ...(context.error === undefined ? {} : { error: describe(context.error) }),
    };
    this.#options.onExchange?.(record);
  }
}

function describe(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

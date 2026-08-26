import { ProviderError, TransportError } from '../errors';

/**
 * How long to wait before trying again.
 *
 * Full jitter, not exponential-plus-a-little: six models opening a round
 * together will fail together, and without independent randomness they would
 * retry together too, re-creating the burst that caused the 429 at every level
 * of the backoff. `random()` is injectable so a test can pin it.
 */

export interface BackoffOptions {
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly random?: () => number;
}

export const DEFAULT_BACKOFF: Required<Omit<BackoffOptions, 'random'>> = {
  baseMs: 500,
  maxMs: 30_000,
};

/** `attempt` is 1 for the wait after the first failure. */
export function computeBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? DEFAULT_BACKOFF.baseMs;
  const maxMs = options.maxMs ?? DEFAULT_BACKOFF.maxMs;
  const random = options.random ?? Math.random;

  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(random() * ceiling);
}

/**
 * The provider's own `retry-after` beats any backoff we would compute.
 *
 * It is the only number in the exchange that is not a guess: ignoring it in
 * favour of a formula is how a client earns a longer ban.
 */
export function retryDelayMs(
  error: unknown,
  attempt: number,
  options: BackoffOptions = {},
): number {
  if (error instanceof ProviderError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  return computeBackoffMs(attempt, options);
}

/** Whether this failure is worth another attempt at all. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;
  if (error instanceof TransportError) return true;
  return false;
}

/** Injectable so tests do not spend real seconds proving a policy. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

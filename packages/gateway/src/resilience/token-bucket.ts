/**
 * A token bucket, one per provider.
 *
 * Providers publish limits per minute; a bucket spends them smoothly instead of
 * firing a session's whole opening round in the same millisecond and taking a
 * 429 for it. Refill is continuous rather than on a timer — there is no
 * interval to leak, and a bucket that nobody asks about costs nothing.
 */

export interface TokenBucketOptions {
  /** The most that can be spent at once, and the ceiling refill climbs to. */
  readonly capacity: number;
  readonly refillPerSecond: number;
  /** Starts full unless a cold start is wanted. */
  readonly initialTokens?: number;
  readonly now?: () => number;
}

export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly #now: () => number;
  #tokens: number;
  #updatedAt: number;

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.#now = options.now ?? (() => Date.now());
    this.#tokens = options.initialTokens ?? options.capacity;
    this.#updatedAt = this.#now();
  }

  /** Tokens available right now, after accounting for elapsed time. */
  get tokens(): number {
    this.#refill();
    return this.#tokens;
  }

  /** Spends `count` if they are there. False means nothing was taken. */
  tryTake(count = 1): boolean {
    this.#refill();
    if (this.#tokens < count) return false;
    this.#tokens -= count;
    return true;
  }

  /** Milliseconds until `count` tokens exist. 0 when they already do. */
  msUntilAvailable(count = 1): number {
    this.#refill();
    if (this.#tokens >= count) return 0;
    if (this.refillPerSecond <= 0) return Number.POSITIVE_INFINITY;
    return Math.ceil(((count - this.#tokens) / this.refillPerSecond) * 1000);
  }

  /**
   * Puts tokens back.
   *
   * Used when a call is refused downstream — by an open breaker, or by a budget
   * cap — because a request that never left should not have cost rate budget.
   */
  refund(count = 1): void {
    this.#refill();
    this.#tokens = Math.min(this.capacity, this.#tokens + count);
  }

  #refill(): void {
    const now = this.#now();
    const elapsedMs = now - this.#updatedAt;
    if (elapsedMs <= 0) return;
    this.#updatedAt = now;
    this.#tokens = Math.min(
      this.capacity,
      this.#tokens + (elapsedMs / 1000) * this.refillPerSecond,
    );
  }
}

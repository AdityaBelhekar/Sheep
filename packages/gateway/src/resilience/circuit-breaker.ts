import { CircuitOpenError } from '../errors';

/**
 * A circuit breaker, one per provider.
 *
 * Retries help with a bad minute and hurt with a bad hour: once a provider is
 * genuinely down, every retry adds latency to a call that will fail anyway and
 * load to a service that is already struggling. The breaker turns the tenth
 * failure into an immediate, cheap refusal, and lets exactly one call through
 * later to find out whether that is still true.
 */

export const CIRCUIT_STATES = ['closed', 'open', 'half-open'] as const;
export type CircuitState = (typeof CIRCUIT_STATES)[number];

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  readonly failureThreshold?: number;
  /** How long it stays open before one probe is allowed through. */
  readonly resetTimeoutMs?: number;
  /** Consecutive successes needed to close it again. */
  readonly successThreshold?: number;
  readonly now?: () => number;
}

const DEFAULTS = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  successThreshold: 1,
};

export class CircuitBreaker {
  readonly #options: Required<Omit<CircuitBreakerOptions, 'now'>>;
  readonly #now: () => number;
  #state: CircuitState = 'closed';
  #failures = 0;
  #successes = 0;
  #openedAt = 0;
  /** One probe at a time while half-open, or a burst would all get through. */
  #probeInFlight = false;

  constructor(
    readonly name: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.#options = {
      failureThreshold: options.failureThreshold ?? DEFAULTS.failureThreshold,
      resetTimeoutMs: options.resetTimeoutMs ?? DEFAULTS.resetTimeoutMs,
      successThreshold: options.successThreshold ?? DEFAULTS.successThreshold,
    };
    this.#now = options.now ?? (() => Date.now());
  }

  get state(): CircuitState {
    this.#maybeHalfOpen();
    return this.#state;
  }

  get failures(): number {
    return this.#failures;
  }

  /** Throws `CircuitOpenError` when the call must not be attempted. */
  assertAllowed(): void {
    this.#maybeHalfOpen();

    if (this.#state === 'open') {
      throw new CircuitOpenError(this.name, this.#msUntilProbe());
    }
    if (this.#state === 'half-open' && this.#probeInFlight) {
      throw new CircuitOpenError(this.name, this.#options.resetTimeoutMs);
    }
    if (this.#state === 'half-open') this.#probeInFlight = true;
  }

  onSuccess(): void {
    this.#probeInFlight = false;
    this.#failures = 0;

    if (this.#state === 'half-open') {
      this.#successes += 1;
      if (this.#successes >= this.#options.successThreshold) this.#close();
      return;
    }
    this.#successes = 0;
  }

  onFailure(): void {
    this.#probeInFlight = false;
    this.#successes = 0;
    this.#failures += 1;

    // A failed probe re-opens immediately: the provider is still down, and the
    // threshold has already been met once.
    if (this.#state === 'half-open' || this.#failures >= this.#options.failureThreshold) {
      this.#open();
    }
  }

  /** Forces the circuit closed — for a user pressing "try again" themselves. */
  reset(): void {
    this.#close();
  }

  #open(): void {
    this.#state = 'open';
    this.#openedAt = this.#now();
    this.#probeInFlight = false;
  }

  #close(): void {
    this.#state = 'closed';
    this.#failures = 0;
    this.#successes = 0;
    this.#probeInFlight = false;
  }

  #maybeHalfOpen(): void {
    if (this.#state === 'open' && this.#msUntilProbe() <= 0) {
      this.#state = 'half-open';
      this.#successes = 0;
      this.#probeInFlight = false;
    }
  }

  #msUntilProbe(): number {
    return this.#openedAt + this.#options.resetTimeoutMs - this.#now();
  }
}

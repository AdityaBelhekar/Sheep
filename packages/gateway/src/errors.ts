/**
 * Gateway error types.
 *
 * Every failure the gateway raises carries a stable `code`, because the
 * orchestrator and the UI need to branch on *why* a call failed — an
 * unsupported capability is a configuration mistake the user can fix, a stream
 * protocol violation is an adapter bug, and Stage 2's later phases add retry
 * decisions on top of these same codes.
 */

export const GATEWAY_ERROR_CODES = {
  unknownAdapter: 'GATEWAY_UNKNOWN_ADAPTER',
  duplicateAdapter: 'GATEWAY_DUPLICATE_ADAPTER',
  unknownModel: 'GATEWAY_UNKNOWN_MODEL',
  unsupportedCapability: 'GATEWAY_UNSUPPORTED_CAPABILITY',
  invalidRequest: 'GATEWAY_INVALID_REQUEST',
  invalidDelta: 'GATEWAY_INVALID_DELTA',
  streamProtocol: 'GATEWAY_STREAM_PROTOCOL',
  pricingUnknown: 'GATEWAY_PRICING_UNKNOWN',
  cancelled: 'GATEWAY_CANCELLED',
  provider: 'GATEWAY_PROVIDER_ERROR',
  transport: 'GATEWAY_TRANSPORT_ERROR',
  rateLimited: 'GATEWAY_RATE_LIMITED',
  circuitOpen: 'GATEWAY_CIRCUIT_OPEN',
  budgetExceeded: 'GATEWAY_BUDGET_EXCEEDED',
  credential: 'GATEWAY_CREDENTIAL_ERROR',
} as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[keyof typeof GATEWAY_ERROR_CODES];

export abstract class GatewayError extends Error {
  abstract readonly code: GatewayErrorCode;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Nothing is registered under that adapter id. */
export class UnknownAdapterError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.unknownAdapter;

  constructor(readonly adapterId: string) {
    super(`No adapter registered with id: ${adapterId}`);
  }
}

/** Two adapters claimed the same id. */
export class DuplicateAdapterError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.duplicateAdapter;

  constructor(readonly adapterId: string) {
    super(`An adapter is already registered with id: ${adapterId}`);
  }
}

/** The adapter is real but does not know that model. */
export class UnknownModelError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.unknownModel;

  constructor(
    readonly adapterId: string,
    readonly modelId: string,
  ) {
    super(`Adapter ${adapterId} does not serve model: ${modelId}`);
  }
}

/**
 * The request asks for something the model cannot do.
 *
 * Caught before a byte leaves the machine: a silent downgrade (dropping tools,
 * ignoring a seed) would make a run irreproducible in a way nothing downstream
 * could detect.
 */
export class UnsupportedCapabilityError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.unsupportedCapability;

  constructor(
    readonly modelId: string,
    readonly capabilities: readonly string[],
  ) {
    super(`Model ${modelId} does not support: ${capabilities.join(', ')}`);
  }
}

/** A request failed its schema before dispatch. */
export class InvalidRequestError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.invalidRequest;

  constructor(readonly issues: readonly string[]) {
    super(`Invalid model request: ${issues.join('; ')}`);
  }
}

/** An adapter emitted something that is not a `Delta`. */
export class InvalidDeltaError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.invalidDelta;

  constructor(
    readonly adapterId: string,
    readonly issues: readonly string[],
  ) {
    super(`Adapter ${adapterId} emitted an invalid delta: ${issues.join('; ')}`);
  }
}

/** An adapter emitted valid deltas in an impossible order. */
export class StreamProtocolError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.streamProtocol;

  constructor(
    readonly adapterId: string,
    reason: string,
  ) {
    super(`Adapter ${adapterId} broke the delta protocol: ${reason}`);
  }
}

/** A cost was asked for on a model with no pricing on file. */
export class PricingUnknownError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.pricingUnknown;

  constructor(readonly modelId: string) {
    super(`No pricing on file for model: ${modelId}`);
  }
}

/** The caller's `AbortSignal` fired mid-stream. */
export class StreamCancelledError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.cancelled;

  constructor(readonly adapterId: string) {
    super(`Stream cancelled by the caller on adapter: ${adapterId}`);
  }
}

/**
 * The provider answered, and the answer was a failure.
 *
 * `retryable` is decided once, here, from the status and the vendor's own error
 * type — so the resilience layer never has to know which vendor it is wrapping,
 * and a new adapter inherits correct retry behaviour by constructing this
 * correctly rather than by being added to a list somewhere else.
 */
export class ProviderError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.provider;
  /** The vendor's machine-readable error type, when it sends one. */
  readonly providerType: string | undefined;
  readonly retryable: boolean;
  /** From `retry-after`, in milliseconds. Honoured before any backoff. */
  readonly retryAfterMs: number | undefined;
  /** The raw body, kept for the CAS record. Never contains credentials. */
  readonly body: string | undefined;

  constructor(
    readonly adapterId: string,
    readonly status: number,
    readonly providerMessage: string,
    options: {
      readonly providerType?: string;
      readonly retryable?: boolean;
      readonly retryAfterMs?: number;
      readonly body?: string;
    } = {},
  ) {
    super(`${adapterId} returned ${String(status)}: ${providerMessage}`);
    this.providerType = options.providerType;
    this.retryable = options.retryable ?? isRetryableStatus(status);
    this.retryAfterMs = options.retryAfterMs;
    this.body = options.body;
  }
}

/**
 * 408 request timeout, 409 conflict, 425 too early, 429 too many requests, and
 * anything the server admits is its own fault.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/** The request never got an answer: DNS, TLS, socket, or a timeout of our own. */
export class TransportError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.transport;
  /** Always true: a request that never reached the provider cost nothing. */
  readonly retryable = true;

  constructor(
    readonly adapterId: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`${adapterId} could not be reached: ${reason}`, options);
  }
}

/** A local token bucket refused the call before it left the machine. */
export class RateLimitedError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.rateLimited;

  constructor(
    readonly adapterId: string,
    readonly waitMs: number,
  ) {
    super(`${adapterId} is rate limited locally; ${String(Math.ceil(waitMs))}ms until a slot`);
  }
}

/** The breaker is open: this provider is failing and is being left alone. */
export class CircuitOpenError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.circuitOpen;

  constructor(
    readonly adapterId: string,
    readonly retryAfterMs: number,
  ) {
    super(`${adapterId} circuit is open; retrying in ${String(Math.ceil(retryAfterMs))}ms`);
  }
}

/** The call would have taken the session past a spend cap. */
export class BudgetExceededError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.budgetExceeded;

  constructor(
    readonly scope: string,
    readonly spentUsd: number,
    readonly capUsd: number,
    readonly wouldCostUsd: number,
  ) {
    super(
      `${scope} would exceed its cap: $${spentUsd.toFixed(4)} spent + ` +
        `$${wouldCostUsd.toFixed(4)} estimated > $${capUsd.toFixed(4)}`,
    );
  }
}

/** No usable credential: none stored, or the stored one was rejected. */
export class CredentialError extends GatewayError {
  readonly code = GATEWAY_ERROR_CODES.credential;

  constructor(
    readonly adapterId: string,
    reason: string,
  ) {
    super(`${adapterId} has no usable credential: ${reason}`);
  }
}

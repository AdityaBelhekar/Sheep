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

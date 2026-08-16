/**
 * IPC error types.
 *
 * Deliberately free of any zod import: the preload script imports this module
 * and must stay a tiny, dependency-free bundle.
 */

export const IPC_ERROR_CODES = {
  unknownChannel: 'IPC_UNKNOWN_CHANNEL',
  noHandler: 'IPC_NO_HANDLER',
  duplicateHandler: 'IPC_DUPLICATE_HANDLER',
  invalidRequest: 'IPC_INVALID_REQUEST',
  invalidResponse: 'IPC_INVALID_RESPONSE',
} as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[keyof typeof IPC_ERROR_CODES];

export abstract class IpcError extends Error {
  abstract readonly code: IpcErrorCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The channel is not in the contract registry at all. */
export class UnknownChannelError extends IpcError {
  readonly code = IPC_ERROR_CODES.unknownChannel;

  constructor(readonly channel: string) {
    super(`Unknown IPC channel: ${channel}`);
  }
}

/** The channel exists in the contracts but nothing registered a handler. */
export class NoHandlerError extends IpcError {
  readonly code = IPC_ERROR_CODES.noHandler;

  constructor(readonly channel: string) {
    super(`No handler registered for IPC channel: ${channel}`);
  }
}

/** Two handlers were registered for the same channel. */
export class DuplicateHandlerError extends IpcError {
  readonly code = IPC_ERROR_CODES.duplicateHandler;

  constructor(readonly channel: string) {
    super(`A handler is already registered for IPC channel: ${channel}`);
  }
}

/** A payload failed its contract. `issues` are human-readable paths + messages. */
export class IpcValidationError extends IpcError {
  readonly code: IpcErrorCode;

  constructor(
    readonly channel: string,
    readonly direction: 'request' | 'response',
    readonly issues: readonly string[],
  ) {
    super(`Invalid IPC ${direction} on ${channel}: ${issues.join('; ')}`);
    this.code =
      direction === 'request' ? IPC_ERROR_CODES.invalidRequest : IPC_ERROR_CODES.invalidResponse;
  }
}

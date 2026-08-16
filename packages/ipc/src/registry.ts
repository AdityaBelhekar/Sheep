import { assertKnownChannel, IPC_CHANNELS, type IpcChannel } from './channels';
import { contractFor, describeIssues, type IpcRequest, type IpcResponse } from './contracts';
import { DuplicateHandlerError, IpcValidationError, NoHandlerError } from './errors';

/** What the transport knows about the caller. Grows in later phases. */
export interface IpcCallContext {
  readonly senderId?: number;
}

export type IpcHandler<C extends IpcChannel> = (
  request: IpcRequest<C>,
  context: IpcCallContext,
) => IpcResponse<C> | Promise<IpcResponse<C>>;

/**
 * Main-process side of the bridge.
 *
 * A channel must be on the allowlist to be registered, its request is validated
 * before the handler runs, and its response is validated before it goes back —
 * so a handler bug cannot ship an off-contract payload to the renderer.
 */
export class IpcRegistry {
  readonly #handlers = new Map<IpcChannel, IpcHandler<IpcChannel>>();

  register<C extends IpcChannel>(channel: C, handler: IpcHandler<C>): this {
    assertKnownChannel(channel);
    if (this.#handlers.has(channel)) throw new DuplicateHandlerError(channel);
    this.#handlers.set(channel, handler as IpcHandler<IpcChannel>);
    return this;
  }

  has(channel: string): boolean {
    return this.#handlers.has(channel as IpcChannel);
  }

  /** Channels that currently have a handler, in allowlist order. */
  registeredChannels(): IpcChannel[] {
    return IPC_CHANNELS.filter((channel) => this.#handlers.has(channel));
  }

  /** Channels on the allowlist with no handler — a wiring bug if non-empty. */
  missingChannels(): IpcChannel[] {
    return IPC_CHANNELS.filter((channel) => !this.#handlers.has(channel));
  }

  async dispatch(
    channel: string,
    payload: unknown,
    context: IpcCallContext = {},
  ): Promise<unknown> {
    assertKnownChannel(channel);
    const handler = this.#handlers.get(channel);
    if (!handler) throw new NoHandlerError(channel);

    const contract = contractFor(channel);

    const request = contract.request.safeParse(payload);
    if (!request.success) {
      throw new IpcValidationError(channel, 'request', describeIssues(request.error));
    }

    const result = await handler(request.data, context);

    const response = contract.response.safeParse(result);
    if (!response.success) {
      throw new IpcValidationError(channel, 'response', describeIssues(response.error));
    }
    return response.data;
  }
}

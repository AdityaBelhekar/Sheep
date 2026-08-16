import { assertKnownChannel, type IpcChannel } from './channels';
import { contractFor, describeIssues, type IpcRequest, type IpcResponse } from './contracts';
import { IpcValidationError } from './errors';

/** Whatever actually carries bytes to the main process (the preload bridge). */
export interface IpcTransport {
  invoke(channel: string, payload: unknown): Promise<unknown>;
}

export interface IpcClient {
  /** Type-safe call: request validated before send, reply validated on arrival. */
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  /** Liveness probe. `roundTripMs` is measured in the renderer. */
  ping(): Promise<IpcResponse<'sheep:ping'> & { roundTripMs: number }>;
}

export interface IpcClientOptions {
  /** Injectable clock, so tests are not at the mercy of wall time. */
  readonly now?: () => number;
}

export function createIpcClient(
  transport: IpcTransport,
  options: IpcClientOptions = {},
): IpcClient {
  const now = options.now ?? (() => Date.now());

  async function invoke<C extends IpcChannel>(
    channel: C,
    request: IpcRequest<C>,
  ): Promise<IpcResponse<C>> {
    assertKnownChannel(channel);
    const contract = contractFor(channel);

    const outgoing = contract.request.safeParse(request);
    if (!outgoing.success) {
      throw new IpcValidationError(channel, 'request', describeIssues(outgoing.error));
    }

    const raw = await transport.invoke(channel, outgoing.data);

    const incoming = contract.response.safeParse(raw);
    if (!incoming.success) {
      throw new IpcValidationError(channel, 'response', describeIssues(incoming.error));
    }
    // `contract` is indexed by the generic C, which TypeScript widens to the
    // union of all responses; the parse above is what actually guarantees this.
    return incoming.data as IpcResponse<C>;
  }

  return {
    invoke,
    async ping() {
      const sentAt = now();
      const reply = await invoke('sheep:ping', { sentAt });
      return { ...reply, roundTripMs: now() - sentAt };
    },
  };
}

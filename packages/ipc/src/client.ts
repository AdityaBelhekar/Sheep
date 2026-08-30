import {
  assertKnownChannel,
  assertKnownEventChannel,
  type IpcChannel,
  type IpcEventChannel,
} from './channels';
import { contractFor, describeIssues, type IpcRequest, type IpcResponse } from './contracts';
import { eventContractFor, type IpcEventPayload } from './events';
import { IpcValidationError } from './errors';

/** Whatever actually carries bytes to the main process (the preload bridge). */
export interface IpcTransport {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  /** Optional: a transport with no event support simply never delivers one. */
  subscribe?(channel: string, listener: (payload: unknown) => void): () => void;
}

export interface IpcClient {
  /** Type-safe call: request validated before send, reply validated on arrival. */
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  /**
   * Listens on a one-way channel. Returns the unsubscribe.
   *
   * A payload that fails its schema is dropped rather than delivered: an event
   * has no caller to reject it, so the only place a malformed one can be
   * refused is here. `onInvalid` is how a caller finds out it happened.
   */
  on<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventPayload<C>) => void,
    options?: { onInvalid?: (issues: readonly string[]) => void },
  ): () => void;
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

    on(channel, listener, options = {}) {
      assertKnownEventChannel(channel);
      const subscribe = transport.subscribe;
      if (!subscribe) return () => undefined;

      const schema = eventContractFor(channel);
      return subscribe(channel, (raw) => {
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          options.onInvalid?.(describeIssues(parsed.error));
          return;
        }
        // Indexed by the generic C, which TypeScript widens to the union of all
        // event payloads; the parse above is what actually guarantees this.
        listener(parsed.data as IpcEventPayload<typeof channel>);
      });
    },

    async ping() {
      const sentAt = now();
      const reply = await invoke('sheep:ping', { sentAt });
      return { ...reply, roundTripMs: now() - sentAt };
    },
  };
}

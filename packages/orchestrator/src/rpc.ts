/**
 * Bidirectional JSON-RPC over a message port.
 *
 * The orchestrator lives in its own process, so the two halves of Stage 4 talk
 * past each other constantly: main asks the child to run a session, and the
 * child asks main to append events and call models — because main is the
 * process that owns the database handle and the adapter registry, and a second
 * owner of either would be a second answer to "what happened".
 *
 * Both directions therefore need to make requests, which is why this is a peer
 * rather than a client and a server. Three properties are what make it safe to
 * build a protocol on:
 *
 * - **Every request settles.** Closing the peer rejects everything in flight.
 *   A child that dies mid-phase must not leave main awaiting a reply forever.
 * - **Errors cross as errors.** A handler that throws arrives at the caller as
 *   a rejection carrying the same message, not as a silent timeout.
 * - **Unknown methods are refused, not ignored.** A version mismatch between
 *   the two halves should be loud on the first call.
 */

/** The transport this peer speaks over: `utilityProcess` or a `MessagePort`. */
export interface RpcTransport {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** Optional: released when the peer closes. */
  dispose?(): void;
}

export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

export interface RpcPeerOptions {
  readonly handlers?: Readonly<Record<string, RpcHandler>>;
  /** Milliseconds before an unanswered request rejects. 0 disables. */
  readonly timeoutMs?: number;
  readonly onError?: (error: Error) => void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

type Envelope =
  | { readonly id: number; readonly method: string; readonly params: unknown }
  | { readonly method: string; readonly params: unknown }
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: { readonly message: string } };

export class RpcClosedError extends Error {
  constructor(reason: string) {
    super(`orchestrator rpc closed: ${reason}`);
    this.name = 'RpcClosedError';
  }
}

export class RpcTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`orchestrator rpc timed out after ${String(ms)}ms: ${method}`);
    this.name = 'RpcTimeoutError';
  }
}

/** Default: long enough for a slow model turn, short enough to notice a hang. */
export const DEFAULT_RPC_TIMEOUT_MS = 10 * 60_000;

export class RpcPeer {
  readonly #transport: RpcTransport;
  readonly #handlers: Map<string, RpcHandler>;
  readonly #pending = new Map<number, Pending>();
  readonly #timeoutMs: number;
  readonly #onError: (error: Error) => void;
  #nextId = 1;
  #closed: string | null = null;

  constructor(transport: RpcTransport, options: RpcPeerOptions = {}) {
    this.#transport = transport;
    this.#handlers = new Map(Object.entries(options.handlers ?? {}));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.#onError = options.onError ?? (() => undefined);
    transport.onMessage((message) => {
      this.#receive(message);
    });
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  /** Registers (or replaces) one method. */
  handle(method: string, handler: RpcHandler): this {
    this.#handlers.set(method, handler);
    return this;
  }

  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.#closed !== null) throw new RpcClosedError(this.#closed);

    const id = this.#nextId++;
    return await new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: null,
      };
      if (this.#timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new RpcTimeoutError(method, this.#timeoutMs));
        }, this.#timeoutMs);
        pending.timer.unref?.();
      }
      this.#pending.set(id, pending);
      this.#transport.post({ id, method, params });
    });
  }

  /** Fire-and-forget. Used for progress, which must never block a phase. */
  notify(method: string, params: unknown = {}): void {
    if (this.#closed !== null) return;
    this.#transport.post({ method, params });
  }

  /** Rejects everything in flight and stops accepting. Idempotent. */
  close(reason = 'closed'): void {
    if (this.#closed !== null) return;
    this.#closed = reason;
    for (const [id, pending] of this.#pending) {
      if (pending.timer) clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(new RpcClosedError(reason));
    }
    this.#transport.dispose?.();
  }

  #receive(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const envelope = message as Partial<Envelope> & Record<string, unknown>;

    if (typeof envelope['method'] === 'string') {
      void this.#dispatch(envelope['method'], envelope['params'], envelope['id']);
      return;
    }
    if (typeof envelope['id'] !== 'number') return;

    const pending = this.#pending.get(envelope['id']);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.#pending.delete(envelope['id']);

    const failure = envelope['error'] as { message?: unknown } | undefined;
    if (failure) {
      pending.reject(new Error(String(failure.message ?? 'unknown orchestrator error')));
    } else {
      pending.resolve(envelope['result']);
    }
  }

  async #dispatch(method: string, params: unknown, id: unknown): Promise<void> {
    const handler = this.#handlers.get(method);
    const respond = (envelope: Envelope): void => {
      if (typeof id !== 'number' || this.#closed !== null) return;
      this.#transport.post(envelope);
    };

    if (!handler) {
      const error = new Error(`unknown orchestrator method: ${method}`);
      if (typeof id !== 'number') this.#onError(error);
      respond({ id: id as number, error: { message: error.message } });
      return;
    }

    try {
      const result = (await handler(params ?? {})) ?? null;
      respond({ id: id as number, result });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // A notification's failure has nowhere to be returned to, so it is
      // surfaced here rather than swallowed into an unobserved rejection.
      if (typeof id !== 'number') this.#onError(failure);
      respond({ id: id as number, error: { message: failure.message } });
    }
  }
}

/** Joins two peers in one process. Used by tests, and by the in-process fallback. */
export function pairedTransports(): [RpcTransport, RpcTransport] {
  const listeners: [((m: unknown) => void)[], ((m: unknown) => void)[]] = [[], []];
  const make = (self: 0 | 1): RpcTransport => ({
    post(message) {
      // Async delivery, so a handler that calls back synchronously behaves the
      // same here as it does across a real process boundary.
      const other = listeners[self === 0 ? 1 : 0];
      queueMicrotask(() => {
        for (const listener of [...other]) listener(message);
      });
    },
    onMessage(listener) {
      listeners[self].push(listener);
    },
  });
  return [make(0), make(1)];
}

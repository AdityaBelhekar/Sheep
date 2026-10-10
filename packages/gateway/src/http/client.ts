import { ProviderError, TransportError } from '../errors';
import { toJsonLines, toSseEvents, type SseEvent } from './sse';

/**
 * The one way this package talks to a network.
 *
 * Every adapter goes through here rather than calling `fetch` itself, which is
 * what makes three things true at once: `fetch` is injectable, so every adapter
 * is testable without a server; failures arrive as `ProviderError` or
 * `TransportError` with `retryable` already decided, so Phase 16's resilience
 * layer is vendor-agnostic; and credentials are supplied per request by a
 * function, so a rotated key takes effect on the next call and no header object
 * holding a secret is ever retained.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HeaderProvider = () => Record<string, string> | Promise<Record<string, string>>;

export interface HttpClientOptions {
  /** Named in every error this client raises. */
  readonly adapterId: string;
  /** Without a trailing slash; paths are appended verbatim. */
  readonly baseUrl: string;
  /** Called per request. Return auth headers here, never store them. */
  readonly headers?: HeaderProvider;
  readonly fetch?: FetchLike;
  /** Whole-request ceiling. Streaming requests apply it to the headers only. */
  readonly timeoutMs?: number;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly query?: Record<string, string | undefined>;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Two minutes to first byte. A model that has said nothing by then is stuck. */
const DEFAULT_TIMEOUT_MS = 120_000;

export class HttpClient {
  readonly #options: HttpClientOptions;
  readonly #fetch: FetchLike;

  constructor(options: HttpClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  get baseUrl(): string {
    return this.#options.baseUrl;
  }

  /** Sends the request and returns a response that is known to be `ok`. */
  async send(request: HttpRequest): Promise<Response> {
    const url = this.#url(request);
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(await this.#options.headers?.()),
      ...request.headers,
    };
    if (request.body !== undefined) headers['content-type'] = 'application/json';

    const timeoutMs = request.timeoutMs ?? this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = combineSignals(request.signal, timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: request.method,
        headers,
        // `fetch` drops `authorization` when a redirect changes origin, but not
        // `x-api-key`, `api-key` or `x-goog-api-key`. No provider's API redirects.
        redirect: 'error',
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      // An abort the *caller* asked for is not a transport failure; let it out
      // as-is so cancellation is never mistaken for a provider being down.
      if (request.signal?.aborted) throw cause;
      throw new TransportError(this.#options.adapterId, describe(cause), { cause });
    }

    if (!response.ok) throw await this.#toProviderError(response);
    return response;
  }

  async json<T>(request: HttpRequest): Promise<T> {
    const response = await this.send(request);
    return (await response.json()) as T;
  }

  /** Streams `text/event-stream` responses. Adds the `accept` header itself. */
  async *sse(request: HttpRequest): AsyncGenerator<SseEvent, void, undefined> {
    const response = await this.send({
      ...request,
      headers: { accept: 'text/event-stream', ...request.headers },
    });
    yield* toSseEvents(bodyOf(response, this.#options.adapterId));
  }

  /** Streams newline-delimited JSON, as local servers emit. */
  async *jsonLines<T>(request: HttpRequest): AsyncGenerator<T, void, undefined> {
    const response = await this.send(request);
    yield* toJsonLines<T>(bodyOf(response, this.#options.adapterId));
  }

  #url(request: HttpRequest): string {
    const base = `${this.#options.baseUrl}${request.path}`;
    const entries = Object.entries(request.query ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );
    if (entries.length === 0) return base;
    return `${base}?${new URLSearchParams(entries).toString()}`;
  }

  async #toProviderError(response: Response): Promise<ProviderError> {
    const body = await response.text().catch(() => '');
    const parsed = parseProviderError(body);
    return new ProviderError(
      this.#options.adapterId,
      response.status,
      parsed.message ?? response.statusText ?? 'request failed',
      {
        ...(parsed.type === undefined ? {} : { providerType: parsed.type }),
        ...(retryAfterMs(response) === undefined ? {} : { retryAfterMs: retryAfterMs(response) }),
        body,
      },
    );
  }
}

function bodyOf(response: Response, adapterId: string): AsyncIterable<Uint8Array> {
  const body = response.body;
  if (!body) throw new TransportError(adapterId, 'the response had no body to stream');
  return body as unknown as AsyncIterable<Uint8Array>;
}

/**
 * Anthropic, OpenAI, Google and Ollama all nest their message differently.
 * Reading all four shapes here means an adapter never has to.
 */
function parseProviderError(body: string): { message?: string; type?: string } {
  if (body.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;

    const error = record['error'];
    if (typeof error === 'string') return { message: error };
    if (typeof error === 'object' && error !== null) {
      const inner = error as Record<string, unknown>;
      return {
        ...(typeof inner['message'] === 'string' ? { message: inner['message'] } : {}),
        ...(typeof inner['type'] === 'string'
          ? { type: inner['type'] }
          : typeof inner['status'] === 'string'
            ? { type: inner['status'] }
            : {}),
      };
    }
    if (typeof record['message'] === 'string') return { message: record['message'] };
    return {};
  } catch {
    // Not JSON — an HTML error page from a proxy, most likely.
    return { message: body.slice(0, 500) };
  }
}

/** `retry-after` is either seconds or an HTTP date; both are worth honouring. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' ? `${code} (${cause.message})` : cause.message;
  }
  return String(cause);
}

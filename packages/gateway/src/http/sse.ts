/**
 * Server-sent events, and the newline-delimited JSON that local servers use
 * instead.
 *
 * Written here rather than taken from a library because every cloud adapter
 * needs exactly this and nothing else: a byte stream in, one dispatched event
 * at a time out, with no reconnection logic (a half-finished completion cannot
 * be resumed — Phase 16 retries the whole call) and no `EventSource` (which
 * cannot send a POST body).
 */

export interface SseEvent {
  /** The `event:` name, or `'message'` when the stream omits one. */
  readonly event: string;
  /** The `data:` payload, with multiple data lines joined by newlines. */
  readonly data: string;
  readonly id?: string;
}

/** Decodes a byte stream into lines, tolerating chunks that split mid-line. */
export async function* toLines(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      // Tolerate CRLF: some proxies rewrite the line endings.
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      yield line;
      newline = buffer.indexOf('\n');
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer.replace(/\r$/, '');
}

/** Non-empty lines, each parsed as JSON. The shape local servers stream. */
export async function* toJsonLines<T>(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<T, void, undefined> {
  for await (const line of toLines(source)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    yield JSON.parse(trimmed) as T;
  }
}

/**
 * Parses the SSE framing: fields accumulate, a blank line dispatches.
 *
 * Comment lines (`: keep-alive`) are dropped rather than dispatched, which is
 * what keeps an idle stream from producing phantom events.
 */
export async function* toSseEvents(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  let event = '';
  let id: string | undefined;
  let data: string[] = [];

  for await (const line of toLines(source)) {
    if (line.length === 0) {
      if (data.length > 0 || event.length > 0) {
        yield { event: event || 'message', data: data.join('\n'), ...(id ? { id } : {}) };
      }
      event = '';
      id = undefined;
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // "Optionally, a single leading space" is stripped, per the spec.
    const rest = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

    switch (field) {
      case 'event':
        event = rest;
        break;
      case 'data':
        data.push(rest);
        break;
      case 'id':
        id = rest;
        break;
      default:
        break;
    }
  }

  if (data.length > 0 || event.length > 0) {
    yield { event: event || 'message', data: data.join('\n'), ...(id ? { id } : {}) };
  }
}

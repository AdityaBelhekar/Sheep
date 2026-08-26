import type { FetchLike } from './client';

/**
 * Fake HTTP for adapter tests.
 *
 * Adapters are tested against recorded wire shapes rather than a live provider:
 * a test that needs a key and a network cannot run in CI, and the thing worth
 * testing — does this vendor's framing become the right deltas — does not
 * involve the network at all. Live tests exist too, and skip without a key.
 */

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface FakeFetch {
  readonly fetch: FetchLike;
  readonly calls: RecordedCall[];
}

/** A `text/event-stream` body, framed the way a provider frames it. */
export function sseResponse(chunks: readonly string[], init: ResponseInit = {}): Response {
  return new Response(streamOf(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  });
}

/** Builds `event: <name>\ndata: <json>\n\n` frames from event objects. */
export function sseEvents(events: readonly { type: string; [key: string]: unknown }[]): string[] {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

/** A newline-delimited JSON body, as local servers stream. */
export function jsonLinesResponse(rows: readonly unknown[]): Response {
  return new Response(streamOf(rows.map((row) => `${JSON.stringify(row)}\n`)), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

export function errorResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Answers calls from a queue, recording each one.
 *
 * A responder function gets the call, so a test can branch on the path (a
 * catalogue request and a stream request in the same test) or fail the first
 * attempt and succeed on the second.
 */
export function fakeFetch(
  responder: ((call: RecordedCall, index: number) => Response | Promise<Response>) | Response[],
): FakeFetch {
  const calls: RecordedCall[] = [];
  const queue = Array.isArray(responder) ? [...responder] : undefined;

  const fetch: FetchLike = async (url, init = {}) => {
    const call: RecordedCall = {
      url,
      method: init.method ?? 'GET',
      headers: normaliseHeaders(init.headers),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    const index = calls.length;
    calls.push(call);

    if (init.signal?.aborted) throw init.signal.reason ?? new Error('aborted');

    if (queue) {
      const next = queue.shift();
      if (!next) throw new Error(`fakeFetch: no queued response for ${call.method} ${call.url}`);
      return next;
    }
    return await (responder as (c: RecordedCall, i: number) => Response | Promise<Response>)(
      call,
      index,
    );
  };

  return { fetch, calls };
}

function normaliseHeaders(headers: RequestInit['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      // One chunk at a time, so a test can split a JSON payload across chunk
      // boundaries and prove the line decoder survives it.
      controller.enqueue(encoder.encode(chunks[index] ?? ''));
      index += 1;
    },
  });
}

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal Ollama-shaped server on loopback, for the smoke run only.
 *
 * The alternative would have been a seam in production code that swaps in a
 * mock adapter when a flag is set — and a launch check that exercises a
 * different code path than the app does is not a launch check. This is a real
 * HTTP server speaking a real provider's wire format, so the adapter, the
 * resilience wrapper, the delta protocol and the streaming path are all the
 * ones that ship. Only the thing on the other end of the socket is ours.
 *
 * It is never started outside a smoke run, and it binds to 127.0.0.1 on a port
 * the OS chooses, so it is unreachable from anywhere but this machine.
 */

export const SMOKE_MODEL_ID = 'sheep-smoke:1b';

/** Long enough to arrive in several deltas, so batching is actually exercised. */
export const SMOKE_REPLY =
  'A blind-parallel round keeps each model out of the others contexts until every ' +
  'answer is committed, which is what makes the agreement afterwards mean something.';

export interface SmokeProvider {
  readonly baseUrl: string;
  /** Requests served so far, by path. */
  readonly calls: string[];
  close(): Promise<void>;
}

interface ChatRequest {
  model?: string;
  messages?: { role?: string; content?: string }[];
}

/**
 * Streams the reply a word at a time as newline-delimited JSON, which is what
 * Ollama does — including the final `done` row that carries the token counts.
 */
function chatChunks(model: string, prompt: string): string[] {
  const words = SMOKE_REPLY.split(' ');
  const rows = words.map((word, index) =>
    JSON.stringify({
      model,
      message: { role: 'assistant', content: index === 0 ? word : ` ${word}` },
      done: false,
    }),
  );

  rows.push(
    JSON.stringify({
      model,
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: Math.max(1, Math.ceil(prompt.length / 4)),
      eval_count: words.length,
    }),
  );
  return rows.map((row) => `${row}\n`);
}

export async function startSmokeProvider(): Promise<SmokeProvider> {
  const calls: string[] = [];

  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    calls.push(path);

    if (path === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          models: [{ name: SMOKE_MODEL_ID, model: SMOKE_MODEL_ID, size: 1, digest: 'smoke' }],
        }),
      );
      return;
    }

    if (path === '/api/show') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model_info: { 'sheep.context_length': 8192 } }));
      return;
    }

    if (path === '/api/chat') {
      readBody(request as NodeJS.ReadableStream)
        .then((raw) => {
          const body = JSON.parse(raw || '{}') as ChatRequest;
          const prompt = (body.messages ?? []).map((message) => message.content ?? '').join('\n');
          response.writeHead(200, { 'content-type': 'application/x-ndjson' });

          // One chunk per tick, so the renderer sees a stream rather than a
          // single flush — which is the only way the batcher is under any load.
          const chunks = chatChunks(body.model ?? SMOKE_MODEL_ID, prompt);
          let index = 0;
          const tick = (): void => {
            if (index >= chunks.length) {
              response.end();
              return;
            }
            response.write(chunks[index]);
            index += 1;
            setTimeout(tick, 2);
          };
          tick();
        })
        .catch(() => {
          response.writeHead(400).end();
        });
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function readBody(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    stream.on('data', (chunk: Buffer | string) => {
      text += chunk.toString();
    });
    stream.on('end', () => {
      resolve(text);
    });
    stream.on('error', reject);
  });
}

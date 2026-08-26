import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The loopback redirect half of a native-app OAuth flow.
 *
 * The browser is the user's real browser — that is the whole point of doing it
 * this way rather than in an embedded webview: the user sees the real Google
 * address bar and the real padlock, and Sheep never gets a chance to read the
 * password. The redirect comes back to a server on 127.0.0.1 that exists for
 * the length of one sign-in and then stops listening.
 */

export interface LoopbackResult {
  readonly code: string;
  readonly state: string | null;
}

export interface LoopbackServer {
  /** Register this exactly, port and all, as the client's redirect URI. */
  readonly redirectUri: string;
  readonly port: number;
  /** Resolves when the browser comes back; rejects on error, abort or timeout. */
  waitForRedirect(): Promise<LoopbackResult>;
  close(): Promise<void>;
}

export interface LoopbackOptions {
  /** 0 asks the OS for a free port, which is what native apps are allowed. */
  readonly port?: number;
  readonly path?: string;
  /** How long the user has to finish signing in. Default five minutes. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Shown in the browser tab once the redirect lands. */
  readonly successHtml?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;

const SUCCESS_HTML = `<!doctype html><meta charset="utf-8">
<title>Signed in</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<main style="text-align:center"><h1>Signed in</h1><p>You can close this tab and go back to Sheep.</p></main>`;

export async function startLoopbackServer(options: LoopbackOptions = {}): Promise<LoopbackServer> {
  const path = options.path ?? '/callback';
  let settle: ((result: LoopbackResult) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;

  const pending = new Promise<LoopbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== path) {
      response.writeHead(404).end();
      return;
    }

    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');

    if (error) {
      // The user pressed Cancel, most often. Say so in the tab and in the app.
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><meta charset="utf-8"><p>Sign-in failed: ${escapeHtml(error)}`);
      fail?.(new Error(`authorization failed: ${error}`));
      return;
    }
    if (!code) {
      response.writeHead(400).end();
      fail?.(new Error('the redirect carried no authorization code'));
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(options.successHtml ?? SUCCESS_HTML);
    settle?.({ code, state: url.searchParams.get('state') });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1, never 0.0.0.0: this port must not be reachable from the network.
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = address && typeof address === 'object' ? (address as AddressInfo).port : 0;

  const timer = setTimeout(() => {
    fail?.(new Error('timed out waiting for the browser to come back'));
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // Nothing here should hold the process open on its own.
  timer.unref?.();

  const onAbort = (): void => fail?.(new Error('sign-in was cancelled'));
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const close = async (): Promise<void> => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      // Keep-alive sockets from the browser would otherwise hold the port.
      server.closeAllConnections?.();
    });
  };

  return {
    redirectUri: `http://127.0.0.1:${String(port)}${path}`,
    port,
    waitForRedirect: () => pending,
    close,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"]/g, (character) => {
    switch (character) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      default:
        return '&quot;';
    }
  });
}

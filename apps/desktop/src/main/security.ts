import { pathToFileURL } from 'node:url';
import { app, session, shell, type WebContents, type WebFrameMain } from 'electron';
import { logWarn } from './log';
import { bundlePath } from './paths';

/**
 * Renderer dev-server URL, injected by electron-vite in `dev` mode only.
 *
 * Never read in an installed copy: an environment variable must not be able to
 * point the window, and the bridge its preload exposes, at a page of someone
 * else's.
 */
export const rendererDevServerUrl = app.isPackaged
  ? undefined
  : process.env['ELECTRON_RENDERER_URL'];

/** Whether a URL is one of the app's own bundled pages. */
export function isAppUrl(url: string): boolean {
  const root = rendererDevServerUrl ?? pathToFileURL(bundlePath('renderer')).href;
  return url === root || url.startsWith(root.endsWith('/') ? root : root + '/');
}

/**
 * Whether an IPC call came from the app's own page, in a window's main frame.
 *
 * The preload's allowlist limits which channels exist; this is what limits who
 * may speak on them. A frame that is not the app — an iframe, or a window that
 * was somehow navigated away — is refused before a handler sees the payload.
 */
export function isTrustedFrame(frame: WebFrameMain | null): boolean {
  return frame !== null && frame.parent === null && isAppUrl(frame.url);
}

/**
 * Opens a link in the person's browser, if it is a web link.
 *
 * `shell.openExternal` hands a URL to the operating system, which will as
 * happily start a program for `file:`, `ms-msdt:` or `search-ms:` as open a
 * page for `https:`. The links Sheep shows come from literature databases and
 * from imported sessions, so only the web is opened and the rest is logged.
 */
export function openExternalLink(url: string): void {
  let protocol = '';
  try {
    ({ protocol } = new URL(url));
  } catch {
    // Not a URL at all; refused below with the rest.
  }
  if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url);
  else logWarn('refused to open a link that is not a web address: ' + url.slice(0, 200));
}

/**
 * Keeps a window on the app's own page: links leave through the browser, and
 * nothing navigates the window, a frame inside it, or attaches a webview to it.
 */
export function lockNavigation(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on('will-frame-navigate', (event) => {
    if (!isAppUrl(event.url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

const BASE_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];

/**
 * Content-Security-Policy for the renderer.
 *
 * Production allows nothing but the bundled assets. Development additionally
 * allows Vite's inline HMR client and its websocket.
 */
function contentSecurityPolicy(isDev: boolean): string {
  const directives = [...BASE_CSP];
  if (isDev) {
    directives.push(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws://localhost:* http://localhost:*",
    );
  } else {
    // Vite injects <style> tags for imported CSS, hence 'unsafe-inline' here.
    directives.push("script-src 'self'", "style-src 'self' 'unsafe-inline'", "connect-src 'self'");
  }
  return directives.join('; ');
}

/** Installs the CSP and refuses renderer permission requests by default. */
export function applyRendererSecurityPolicy(isDev: boolean): void {
  const csp = contentSecurityPolicy(isDev);

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  // Nothing in Sheep needs camera, microphone, geolocation or notifications.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

import { session } from 'electron';

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

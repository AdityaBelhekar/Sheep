import { BrowserWindow, nativeImage, shell } from 'electron';
import { APP_NAME } from '../shared/product';
import { bundlePath, resourcePath } from './paths';
import { isSmokeRun, recordSmokeCheck } from './smoke';

/** Renderer dev-server URL, injected by electron-vite in `dev` mode only. */
export const rendererDevServerUrl = process.env['ELECTRON_RENDERER_URL'];

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    icon: nativeImage.createFromPath(resourcePath('sheep.png')),
    webPreferences: {
      preload: bundlePath('preload', 'index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
    recordSmokeCheck('window-ready', true, rendererDevServerUrl ? 'dev server' : 'bundled');
  });

  // Links open in the user's browser; nothing navigates the app window away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (rendererDevServerUrl) {
    void window.loadURL(rendererDevServerUrl);
  } else {
    void window.loadFile(bundlePath('renderer', 'index.html'));
  }

  if (isSmokeRun) void verifyRendererMounted(window);

  return window;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Smoke-run only: proves React actually mounted, which also proves the CSP and
 * the preload bridge did not break the renderer.
 */
async function verifyRendererMounted(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (window.isDestroyed()) return;
    try {
      const state: unknown = await window.webContents.executeJavaScript(
        `(() => {
          const root = document.querySelector('[data-sheep-ready]');
          return { mounted: Boolean(root), bridge: Boolean(window.sheep) };
        })()`,
      );
      const { mounted, bridge } = state as { mounted: boolean; bridge: boolean };
      if (mounted) {
        recordSmokeCheck('renderer-mounted', true, bridge ? 'bridge present' : 'bridge missing');
        return;
      }
    } catch {
      // Page still loading; retry until the deadline.
    }
    await delay(200);
  }
  recordSmokeCheck('renderer-mounted', false, 'no [data-sheep-ready] element');
}

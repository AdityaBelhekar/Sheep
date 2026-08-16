import { writeFile } from 'node:fs/promises';
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

  if (isSmokeRun) void runRendererSmokeChecks(window);

  return window;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type RendererState = {
  mounted: boolean;
  bridge: boolean;
  ping: string | null;
  chain: string | null;
};

const RENDERER_STATE_EXPRESSION = `(() => {
  const root = document.querySelector('[data-sheep-ready]');
  return {
    mounted: Boolean(root),
    bridge: Boolean(window.sheep),
    ping: root?.getAttribute('data-sheep-ping') ?? null,
    chain: root?.getAttribute('data-sheep-chain') ?? null,
  };
})()`;

/** Proves the renderer refuses a channel that is not on the allowlist. */
const CHANNEL_GUARD_EXPRESSION = `(async () => {
  try {
    await window.sheep.invoke('sheep:not-a-channel', {});
    return 'no-throw';
  } catch (error) {
    return String(error && error.message ? error.message : error);
  }
})()`;

async function pollRenderer(
  window: BrowserWindow,
  expression: string,
  isDone: (value: unknown) => boolean,
  timeoutMs = 15_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    if (window.isDestroyed()) return last;
    try {
      last = await window.webContents.executeJavaScript(expression);
      if (isDone(last)) return last;
    } catch {
      // Page still loading; retry until the deadline.
    }
    await delay(150);
  }
  return last;
}

/**
 * Smoke-run only: asserts React mounted, the preload bridge is present, the
 * renderer's `ipc.ping()` returned a contract-valid reply, and an unregistered
 * channel is refused.
 */
async function runRendererSmokeChecks(window: BrowserWindow): Promise<void> {
  const settled = (value: string | null | undefined): boolean =>
    value != null && value !== 'pending';

  const state = (await pollRenderer(window, RENDERER_STATE_EXPRESSION, (value) => {
    const s = value as RendererState | undefined;
    return Boolean(s?.mounted) && settled(s?.ping) && settled(s?.chain);
  })) as RendererState | undefined;

  recordSmokeCheck(
    'renderer-mounted',
    Boolean(state?.mounted),
    state?.bridge ? 'bridge present' : 'bridge missing',
  );
  recordSmokeCheck('ipc-ping', state?.ping === 'ok', `ping state: ${state?.ping ?? 'none'}`);
  recordSmokeCheck(
    'renderer-chain-status',
    state?.chain === 'ok',
    `chain state: ${state?.chain ?? 'none'}`,
  );

  if (window.isDestroyed()) return;
  const guard = await window.webContents
    .executeJavaScript(CHANNEL_GUARD_EXPRESSION)
    .catch((error: unknown) => String(error));
  // Capture before the last check is recorded: the final report quits the app.
  await captureScreenshot(window);

  const refused = typeof guard === 'string' && guard.includes('Unknown IPC channel');
  recordSmokeCheck('ipc-channel-guard', refused, String(guard));
}

/**
 * Writes a PNG of the window when SHEEP_SMOKE_SCREENSHOT names a path, so a
 * headless run can leave evidence of what the app actually looked like.
 */
async function captureScreenshot(window: BrowserWindow): Promise<void> {
  const target = process.env['SHEEP_SMOKE_SCREENSHOT'];
  if (!target || window.isDestroyed()) return;

  try {
    const image = await window.webContents.capturePage();
    await writeFile(target, image.toPNG());
    process.stdout.write(`sheep-smoke: screenshot ${target}\n`);
  } catch (error) {
    process.stderr.write(
      `sheep-smoke: screenshot failed - ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

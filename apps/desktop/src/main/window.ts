import { writeFile } from 'node:fs/promises';
import { BrowserWindow, nativeImage, shell } from 'electron';
import { PANE_IDS } from '../shared/panes';
import { APP_NAME } from '../shared/product';
import { logInfo, logWarn } from './log';
import { bundlePath, resourcePath } from './paths';
import { isSmokeRun, recordSmokeCheck } from './smoke';

/** What the navigability check expects to find, taken from the shared list. */
const PANE_COUNT = PANE_IDS.length;

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
  panes: string | null;
  sessions: string | null;
};

const RENDERER_STATE_EXPRESSION = `(() => {
  const root = document.querySelector('[data-sheep-ready]');
  return {
    mounted: Boolean(root),
    bridge: Boolean(window.sheep),
    ping: root?.getAttribute('data-sheep-ping') ?? null,
    chain: root?.getAttribute('data-sheep-chain') ?? null,
    panes: root?.getAttribute('data-sheep-panes') ?? null,
    sessions:
      document.querySelector('[data-pane="sessions"]')?.getAttribute('data-sheep-sessions') ?? null,
  };
})()`;

/**
 * Visits every pane the shell declares and checks each one actually rendered.
 *
 * Driven by the shell's own list rather than a copy of it, so a pane added to
 * the app is a pane this check starts covering.
 */
const NAVIGATION_EXPRESSION = `(async () => {
  const root = document.querySelector('[data-sheep-ready]');
  const panes = (root?.getAttribute('data-sheep-panes') ?? '').split(',').filter(Boolean);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  const visited = [];
  const failed = [];

  for (const pane of panes) {
    window.location.hash = '#/' + pane;
    await settle();
    const active = document.querySelector('[data-sheep-ready]')?.getAttribute('data-sheep-pane');
    const rendered = document.querySelector('[data-pane="' + pane + '"]');
    const heading = rendered?.querySelector('h1')?.textContent ?? '';
    if (active === pane && rendered && heading.length > 0) visited.push(pane);
    else failed.push(pane + '(active=' + String(active) + ' rendered=' + String(Boolean(rendered)) + ')');
  }

  // An unknown route must land somewhere real rather than render nothing.
  window.location.hash = '#/not-a-pane';
  await settle();
  const fallback = document.querySelector('[data-sheep-ready]')?.getAttribute('data-sheep-pane');

  window.location.hash = '#/sessions';
  await settle();
  return { declared: panes.length, visited, failed, fallback };
})()`;

/**
 * Creates a session from the renderer and checks it comes back through the
 * projection: React → IPC → event log → projection → IPC → React, end to end.
 */
const PROJECTION_EXPRESSION = `(async () => {
  const readCount = () =>
    Number(
      document.querySelector('[data-pane="sessions"]')?.getAttribute('data-sheep-sessions') ?? 'NaN',
    );
  const before = readCount();
  const title = 'Smoke check ' + Date.now();

  const reply = await window.sheep.invoke('sheep:session-create', {
    title,
    question: 'Does the projection reach the renderer over IPC?',
  });

  // Re-read through the renderer's own path rather than trusting the reply.
  window.location.hash = '#/conversation';
  await new Promise((resolve) => setTimeout(resolve, 60));
  window.location.hash = '#/sessions';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (readCount() === before + 1 && document.body.textContent.includes(title)) break;
  }

  return {
    before,
    after: readCount(),
    created: reply.sessionId,
    returned: reply.sessions.length,
    projectedThroughSeq: reply.projectedThroughSeq,
    renderedTitle: document.body.textContent.includes(title),
    capUsd: reply.sessions.find((session) => session.sessionId === reply.sessionId)?.budget.capUsd,
  };
})()`;

/** Picks a theme, then reads back what was applied and what was persisted. */
const applyThemeExpression = (option: string): string => `(async () => {
  document.querySelector('[data-sheep-theme-option="${option}"]').click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const persisted = await window.sheep.invoke('sheep:settings-read', {});
  return {
    applied: document.documentElement.getAttribute('data-theme'),
    stored: persisted.settings['ui.theme'],
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

async function evaluate(window: BrowserWindow, expression: string): Promise<unknown> {
  if (window.isDestroyed()) return undefined;
  return window.webContents.executeJavaScript(expression).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
}

/**
 * Smoke-run only: asserts React mounted, the preload bridge is present, the
 * renderer's `ipc.ping()` returned a contract-valid reply, every pane is
 * navigable, a projection read reaches the renderer, the theme persists, and an
 * unregistered channel is refused.
 */
async function runRendererSmokeChecks(window: BrowserWindow): Promise<void> {
  const settled = (value: string | null | undefined): boolean =>
    value != null && value !== 'pending';

  const state = (await pollRenderer(window, RENDERER_STATE_EXPRESSION, (value) => {
    const s = value as RendererState | undefined;
    return Boolean(s?.mounted) && settled(s?.ping) && settled(s?.chain) && settled(s?.sessions);
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

  await checkNavigation(window);
  await checkProjection(window);
  await checkTheme(window);

  if (window.isDestroyed()) return;
  const guard = await window.webContents
    .executeJavaScript(CHANNEL_GUARD_EXPRESSION)
    .catch((error: unknown) => String(error));
  // Capture before the last check is recorded: the final report quits the app.
  await captureScreenshot(window);

  const refused = typeof guard === 'string' && guard.includes('Unknown IPC channel');
  recordSmokeCheck('ipc-channel-guard', refused, String(guard));
}

async function checkNavigation(window: BrowserWindow): Promise<void> {
  const result = (await evaluate(window, NAVIGATION_EXPRESSION)) as
    | { declared: number; visited: string[]; failed: string[]; fallback: string | null }
    | { error: string }
    | undefined;

  if (!result || 'error' in result) {
    recordSmokeCheck('renderer-navigation', false, result?.error ?? 'no result');
    return;
  }

  const ok =
    result.declared === PANE_COUNT &&
    result.visited.length === PANE_COUNT &&
    result.failed.length === 0 &&
    result.fallback === 'sessions';

  recordSmokeCheck(
    'renderer-navigation',
    ok,
    `${String(result.visited.length)}/${String(result.declared)} panes rendered · unknown route → ${
      result.fallback ?? 'nothing'
    }${result.failed.length > 0 ? ` · failed: ${result.failed.join(', ')}` : ''}`,
  );
}

async function checkProjection(window: BrowserWindow): Promise<void> {
  const result = (await evaluate(window, PROJECTION_EXPRESSION)) as
    | {
        before: number;
        after: number;
        created: string;
        returned: number;
        projectedThroughSeq: number;
        renderedTitle: boolean;
        capUsd: number | null;
      }
    | { error: string }
    | undefined;

  if (!result || 'error' in result) {
    recordSmokeCheck('renderer-projection', false, result?.error ?? 'no result');
    return;
  }

  const ok = result.after === result.before + 1 && result.renderedTitle && result.returned > 0;
  recordSmokeCheck(
    'renderer-projection',
    ok,
    `sessions ${String(result.before)} → ${String(result.after)} · projected through seq ${String(
      result.projectedThroughSeq,
    )} · default cap ${result.capUsd === null ? 'none' : `$${String(result.capUsd)}`}`,
  );
}

type ThemeResult = { applied: string | null; stored: string } | { error: string } | undefined;

/**
 * Switches theme in both directions and checks each choice both took effect and
 * was persisted. A screenshot of each is left behind when one is asked for, so
 * two themes means two pieces of evidence rather than one.
 */
async function checkTheme(window: BrowserWindow): Promise<void> {
  const light = (await evaluate(window, applyThemeExpression('light'))) as ThemeResult;
  await captureScreenshot(window, 'light');
  const dark = (await evaluate(window, applyThemeExpression('dark'))) as ThemeResult;

  if (!light || 'error' in light || !dark || 'error' in dark) {
    const detail = [light, dark]
      .map((result) => (result && 'error' in result ? result.error : 'ok'))
      .join(' · ');
    recordSmokeCheck('renderer-theme', false, detail);
    return;
  }

  const ok =
    light.applied === 'light' &&
    light.stored === 'light' &&
    dark.applied === 'dark' &&
    dark.stored === 'dark';

  recordSmokeCheck(
    'renderer-theme',
    ok,
    `light applied=${light.applied ?? 'none'} persisted=${light.stored} · ` +
      `dark applied=${dark.applied ?? 'none'} persisted=${dark.stored}`,
  );
}

/**
 * Writes a PNG of the window when SHEEP_SMOKE_SCREENSHOT names a path, so a
 * headless run can leave evidence of what the app actually looked like.
 */
async function captureScreenshot(window: BrowserWindow, label?: string): Promise<void> {
  const configured = process.env['SHEEP_SMOKE_SCREENSHOT'];
  if (!configured || window.isDestroyed()) return;
  const target =
    label === undefined ? configured : configured.replace(/(\.png)?$/i, `-${label}.png`);

  try {
    const image = await window.webContents.capturePage();
    await writeFile(target, image.toPNG());
    logInfo(`smoke screenshot written to ${target}`);
  } catch (error) {
    logWarn('smoke screenshot failed -', error);
  }
}

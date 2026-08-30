import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { BrowserWindow, nativeImage, nativeTheme, shell } from 'electron';
import { listSessions } from '@sheep/store';
import { PANE_IDS } from '../shared/panes';
import { APP_NAME } from '../shared/product';
import { createConnection } from './connections';
import { logInfo, logWarn, redactor } from './log';
import { bundlePath, resourcePath } from './paths';
import { isSmokeRun, recordSmokeCheck } from './smoke';
import {
  SMOKE_MODEL_ID,
  SMOKE_REPLY,
  SMOKE_SLOW_MODEL_ID,
  startSmokeProvider,
} from './smoke-provider';
import { getStore } from './store';

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
    // The colour Electron paints before any HTML exists. Hardcoding the dark
    // one made a light-theme launch flash black; matching the OS gets the first
    // frame close enough that the stylesheet's own first paint is continuous.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d10' : '#f6f7f9',
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

/**
 * Adds, tests and removes a connection from the renderer.
 *
 * The interesting assertion is not that the list grew — it is that the secret
 * typed into the form ends up somewhere the database is not, which the main
 * process checks by reading the file after this returns.
 */
const CONNECTIONS_EXPRESSION = (secret: string): string => `(async () => {
  window.location.hash = '#/connections';
  await new Promise((resolve) => setTimeout(resolve, 80));

  const created = await window.sheep.invoke('sheep:connection-create', {
    label: 'Smoke connection',
    config: { kind: 'anthropic' },
    secret: ${JSON.stringify(secret)},
  });
  const connection = created.connections.find((c) => c.connectionId === created.connectionId);

  const tested = await window.sheep.invoke('sheep:connection-test', {
    connectionId: created.connectionId,
  });

  const renamed = await window.sheep.invoke('sheep:connection-update', {
    connectionId: created.connectionId,
    label: 'Smoke connection (renamed)',
  });

  const detected = await window.sheep.invoke('sheep:local-providers-detect', {});

  return {
    connectionId: created.connectionId,
    count: created.connections.length,
    vaultBackend: created.vaultBackend,
    vendorId: connection?.vendorId ?? null,
    hasCredentialRef: typeof connection?.credentialRef === 'string',
    // No response on any channel may carry the secret back.
    replyLeaksSecret: JSON.stringify(created).includes(${JSON.stringify(secret)}),
    testedHealth: tested.connection.health,
    renamedLabel: renamed.connections.find((c) => c.connectionId === created.connectionId)?.label,
    localProviders: detected.providers.length,
  };
})()`;

const deleteConnectionExpression = (connectionId: string): string => `(async () => {
  const reply = await window.sheep.invoke('sheep:connection-delete', {
    connectionId: ${JSON.stringify(connectionId)},
  });
  return { removed: reply.removed, remaining: reply.connections.length };
})()`;

/**
 * Attaches, reconfigures and detaches a model on a session's roster.
 *
 * Driven against a local runtime connection with a stubbed catalogue, so the
 * check exercises the whole path — IPC, event log, projection, IPC — without
 * needing a key or a network.
 */
const ROSTER_EXPRESSION = (sessionId: string, connectionId: string, modelId: string): string => `
(async () => {
  const before = await window.sheep.invoke('sheep:session-get', {
    sessionId: ${JSON.stringify(sessionId)},
  });

  const attached = await window.sheep.invoke('sheep:roster-attach', {
    sessionId: ${JSON.stringify(sessionId)},
    connectionId: ${JSON.stringify(connectionId)},
    modelId: ${JSON.stringify(modelId)},
    weight: 1,
    budgetCapUsd: 2.5,
    preferredRole: 'PROPOSER',
  });

  const reconfigured = await window.sheep.invoke('sheep:roster-reconfigure', {
    sessionId: ${JSON.stringify(sessionId)},
    participantId: attached.participantId,
    weight: 0.5,
    budgetCapUsd: null,
    preferredRole: null,
  });
  const entry = reconfigured.roster.find((r) => r.participantId === attached.participantId);

  const detached = await window.sheep.invoke('sheep:roster-detach', {
    sessionId: ${JSON.stringify(sessionId)},
    participantId: attached.participantId,
    reason: 'smoke check',
  });

  // A model the connection does not serve must be refused before anything is
  // written down, not discovered at the first call.
  let refusedUnknownModel = false;
  try {
    await window.sheep.invoke('sheep:roster-attach', {
      sessionId: ${JSON.stringify(sessionId)},
      connectionId: ${JSON.stringify(connectionId)},
      modelId: 'not-a-real-model',
      weight: 1,
      budgetCapUsd: null,
      preferredRole: null,
    });
  } catch {
    refusedUnknownModel = true;
  }

  return {
    beforeCount: before.session.participantCount,
    attachedCount: attached.session.participantCount,
    vendorId: attached.roster[0]?.model.vendorId ?? null,
    foundEntry: Boolean(entry),
    weightAfter: entry ? entry.weight : null,
    // Read directly, not through ??: null is the value under test here.
    capAfter: entry ? entry.budgetCapUsd : 'missing',
    roleAfter: entry ? entry.preferredRole : 'missing',
    detachedCount: detached.session.participantCount,
    stillListed: detached.roster.length,
    refusedUnknownModel,
  };
})()`;

/**
 * Sends one turn and watches the answer arrive on the event channel.
 *
 * Driven through the pane's own controls rather than by calling IPC directly,
 * so what is proved is that the surface works — the composer, the subscription,
 * the live turn, and the projected message that replaces it when the run ends.
 */
const CHAT_EXPRESSION = (sessionId: string, expected: string): string => `(async () => {
  await window.sheep.invoke('sheep:settings-write', {
    key: 'ui.lastSessionId',
    value: ${JSON.stringify(sessionId)},
  });

  window.location.hash = '#/conversation';
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await settle(200);

  const pane = () => document.querySelector('[data-pane="conversation"]');
  const composer = pane()?.querySelector('textarea');
  if (!composer) return { error: 'no composer: ' + (pane()?.getAttribute('data-sheep-conversation') ?? 'no pane') };

  // Type through React's own setter, so the change event it listens for fires.
  const setValue = window.Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  ).set;
  setValue.call(composer, 'What makes a blind-parallel round worth the trouble?');
  composer.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(60);

  pane().querySelector('[data-sheep-send]').click();

  // Watch for the live turn appearing, so streaming is observed rather than
  // merely inferred from the finished message.
  let sawStreaming = false;
  let frames = 0;
  let lastLength = -1;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await settle(20);
    const root = document.querySelector('[data-sheep-ready]');
    if (pane()?.getAttribute('data-sheep-streaming') === 'streaming') {
      sawStreaming = true;
      const live = pane().querySelector('.chat__turn--live .chat__body');
      const length = live ? live.textContent.length : -1;
      if (length !== lastLength) {
        frames += 1;
        lastLength = length;
      }
    } else if (sawStreaming) {
      break;
    }
  }

  await settle(300);
  const messages = await window.sheep.invoke('sheep:messages-list', {
    sessionId: ${JSON.stringify(sessionId)},
  });
  const answer = messages.messages[messages.messages.length - 1];
  const question = messages.messages[messages.messages.length - 2];

  return {
    sawStreaming,
    frames,
    total: messages.messages.length,
    questionAuthor: question?.author.kind ?? null,
    answerAuthor: answer?.author.kind ?? null,
    answerVendor: answer?.author.kind === 'MODEL' ? answer.author.model.vendorId : null,
    finish: answer?.finish ?? null,
    text: answer?.body.kind === 'text' ? answer.body.text : '',
    matches: answer?.body.kind === 'text' && answer.body.text === ${JSON.stringify(expected)},
    hasPromptHash: typeof answer?.promptHash === 'string',
    rendered: (pane()?.textContent ?? '').includes(${JSON.stringify(expected.slice(0, 40))}),
  };
})()`;

/**
 * Starts a long answer, stops it, and checks what survived.
 *
 * The claim under test is "cancel mid-stream loses nothing": the text that had
 * already arrived is in the log, marked `cancelled`, and the renderer shows the
 * same thing the log does.
 */
const CANCEL_EXPRESSION = (sessionId: string, participantId: string): string => `(async () => {
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const seen = [];
  const stop = window.sheep.subscribe('sheep:stream-event', (event) => { seen.push(event); });

  try {
    const run = await window.sheep.invoke('sheep:chat-send', {
      sessionId: ${JSON.stringify(sessionId)},
      participantId: ${JSON.stringify(participantId)},
      text: 'Say a great deal, slowly.',
    });

    // Wait for real text, so there is something for cancelling to preserve.
    const deadline = Date.now() + 10000;
    let received = '';
    while (Date.now() < deadline) {
      await settle(20);
      received = seen
        .filter((e) => e.runId === run.runId && e.kind === 'text')
        .map((e) => e.text)
        .join('');
      if (received.length > 40) break;
    }

    const cancel = await window.sheep.invoke('sheep:chat-cancel', { runId: run.runId });

    let end = null;
    const endBy = Date.now() + 10000;
    while (Date.now() < endBy && !end) {
      await settle(20);
      end = seen.find((e) => e.runId === run.runId && e.kind === 'end') ?? null;
    }

    await settle(200);
    const messages = await window.sheep.invoke('sheep:messages-list', {
      sessionId: ${JSON.stringify(sessionId)},
    });
    const stored = messages.messages.find((m) => m.messageId === run.assistantMessageId);
    const streamed = seen
      .filter((e) => e.runId === run.runId && e.kind === 'text')
      .map((e) => e.text)
      .join('');

    return {
      cancelAccepted: cancel.cancelled,
      sawEnd: Boolean(end),
      endFinish: end ? end.finish : null,
      endPartial: end ? end.partial : null,
      streamedChars: streamed.length,
      storedFinish: stored ? stored.finish : null,
      storedChars: stored && stored.body.kind === 'text' ? stored.body.text.length : -1,
      // Nothing that reached the screen may be missing from the record.
      storedKeptEverything: Boolean(stored && stored.body.kind === 'text' && stored.body.text === streamed),
      // The model would have said far more had it not been stopped.
      stoppedEarly: streamed.length > 0 && streamed.length < 3000,
    };
  } finally {
    stop();
  }
})()`;

/**
 * Six models answering at once, counting deltas against IPC messages.
 *
 * "Does not stutter" is not directly observable from here, but the thing that
 * causes it is: one IPC message per token per run. The batcher's job is to make
 * the message count a fraction of the delta count, and that ratio is checkable.
 */
const CONCURRENCY_EXPRESSION = (sessionId: string, participantIds: string[]): string => `
(async () => {
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const ids = ${JSON.stringify(participantIds)};
  const textEvents = new Map();
  const chars = new Map();
  const ended = new Set();

  const stop = window.sheep.subscribe('sheep:stream-event', (event) => {
    if (event.kind === 'text') {
      textEvents.set(event.runId, (textEvents.get(event.runId) ?? 0) + 1);
      chars.set(event.runId, (chars.get(event.runId) ?? 0) + event.text.length);
    }
    if (event.kind === 'end') ended.add(event.runId);
  });

  try {
    const started = Date.now();
    const runs = await Promise.all(
      ids.map((participantId) =>
        window.sheep.invoke('sheep:chat-send', {
          sessionId: ${JSON.stringify(sessionId)},
          participantId,
          text: 'Answer briefly, all of you at once.',
        }),
      ),
    );

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && ended.size < runs.length) await settle(25);

    let events = 0;
    let characters = 0;
    for (const run of runs) {
      events += textEvents.get(run.runId) ?? 0;
      characters += chars.get(run.runId) ?? 0;
    }

    return {
      runs: runs.length,
      finished: ended.size,
      textEvents: events,
      characters,
      // Every run must have produced text, not just most of them.
      allSpoke: runs.every((run) => (chars.get(run.runId) ?? 0) > 0),
      elapsedMs: Date.now() - started,
    };
  } finally {
    stop();
  }
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
  await checkConnections(window);
  await checkLocalModel(window);
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

type RosterResult =
  | {
      beforeCount: number;
      attachedCount: number;
      vendorId: string | null;
      foundEntry: boolean;
      weightAfter: number | null;
      capAfter: number | null | string;
      roleAfter: string | null;
      detachedCount: number;
      stillListed: number;
      refusedUnknownModel: boolean;
    }
  | { error: string }
  | undefined;

/**
 * Drives one session's roster from the renderer against a real local provider.
 *
 * The provider is ours (see `smoke-provider.ts`), but everything above the
 * socket is the shipping path: a stored connection, the Ollama adapter, the
 * resilience wrapper, the event log and the projection.
 */
async function checkLocalModel(window: BrowserWindow): Promise<void> {
  const store = getStore();
  const provider = await startSmokeProvider();

  try {
    const connection = await createConnection({
      label: 'Smoke local runtime',
      config: { kind: 'local', provider: 'ollama', baseUrl: provider.baseUrl },
    });

    const [session] = listSessions(store.db, 1);
    if (!session) {
      const detail = 'no session to attach a model to';
      recordSmokeCheck('renderer-roster', false, detail);
      recordSmokeCheck('renderer-chat', false, detail);
      return;
    }

    await checkRoster(window, session.sessionId, connection.connectionId);
    await checkChat(window, session.sessionId, connection.connectionId);
    await checkCancellation(window, session.sessionId, connection.connectionId);
    await checkConcurrency(window, session.sessionId, connection.connectionId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const name of [
      'renderer-roster',
      'renderer-chat',
      'stream-cancel',
      'stream-concurrency',
    ]) {
      recordSmokeCheck(name, false, detail);
    }
  } finally {
    await provider.close();
  }
}

/** Attaches a model and returns its participant id, or null with the reason. */
async function attachModel(
  window: BrowserWindow,
  sessionId: string,
  connectionId: string,
  modelId: string,
): Promise<{ participantId: string } | { error: string }> {
  const result = (await evaluate(
    window,
    `window.sheep.invoke('sheep:roster-attach', {
       sessionId: ${JSON.stringify(sessionId)},
       connectionId: ${JSON.stringify(connectionId)},
       modelId: ${JSON.stringify(modelId)},
       weight: 1,
       budgetCapUsd: null,
       preferredRole: null,
     }).then((reply) => ({ participantId: reply.participantId }))`,
  )) as { participantId?: string } | { error: string } | undefined;

  if (!result || 'error' in result) return { error: result?.error ?? 'could not attach a model' };
  if (typeof result.participantId !== 'string') return { error: 'no participant id came back' };
  return { participantId: result.participantId };
}

type CancelResult =
  | {
      cancelAccepted: boolean;
      sawEnd: boolean;
      endFinish: string | null;
      endPartial: boolean | null;
      streamedChars: number;
      storedFinish: string | null;
      storedChars: number;
      storedKeptEverything: boolean;
      stoppedEarly: boolean;
    }
  | { error: string }
  | undefined;

async function checkCancellation(
  window: BrowserWindow,
  sessionId: string,
  connectionId: string,
): Promise<void> {
  const attached = await attachModel(window, sessionId, connectionId, SMOKE_SLOW_MODEL_ID);
  if ('error' in attached) {
    recordSmokeCheck('stream-cancel', false, attached.error);
    return;
  }

  const result = (await evaluate(
    window,
    CANCEL_EXPRESSION(sessionId, attached.participantId),
  )) as CancelResult;

  if (!result || 'error' in result) {
    recordSmokeCheck('stream-cancel', false, result?.error ?? 'no result');
    return;
  }

  const ok =
    result.cancelAccepted &&
    result.sawEnd &&
    result.endFinish === 'cancelled' &&
    result.endPartial === true &&
    result.streamedChars > 0 &&
    result.stoppedEarly &&
    result.storedFinish === 'cancelled' &&
    // The point of the whole check: what was shown is what was kept.
    result.storedKeptEverything;

  recordSmokeCheck(
    'stream-cancel',
    ok,
    `accepted=${String(result.cancelAccepted)} · finish=${result.endFinish ?? 'none'}/` +
      `${result.storedFinish ?? 'none'} · partial=${String(result.endPartial)} · ` +
      `streamed ${String(result.streamedChars)} chars, stored ${String(result.storedChars)} · ` +
      `kept everything=${String(result.storedKeptEverything)} · ` +
      `stopped early=${String(result.stoppedEarly)}`,
  );
}

type ConcurrencyResult =
  | {
      runs: number;
      finished: number;
      textEvents: number;
      characters: number;
      allSpoke: boolean;
      elapsedMs: number;
    }
  | { error: string }
  | undefined;

/** Six models at once, and the batching ratio that keeps the UI usable. */
async function checkConcurrency(
  window: BrowserWindow,
  sessionId: string,
  connectionId: string,
): Promise<void> {
  const participantIds: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const attached = await attachModel(window, sessionId, connectionId, SMOKE_MODEL_ID);
    if ('error' in attached) {
      recordSmokeCheck('stream-concurrency', false, attached.error);
      return;
    }
    participantIds.push(attached.participantId);
  }

  const result = (await evaluate(
    window,
    CONCURRENCY_EXPRESSION(sessionId, participantIds),
  )) as ConcurrencyResult;

  if (!result || 'error' in result) {
    recordSmokeCheck('stream-concurrency', false, result?.error ?? 'no result');
    return;
  }

  // Each answer is one delta per word from the provider; the batcher must turn
  // those into materially fewer IPC messages or it is doing nothing.
  const deltas = SMOKE_REPLY.split(' ').length * result.runs;
  const ok =
    result.runs === 6 &&
    result.finished === 6 &&
    result.allSpoke &&
    result.characters > 0 &&
    result.textEvents > 0 &&
    result.textEvents < deltas;

  recordSmokeCheck(
    'stream-concurrency',
    ok,
    `${String(result.finished)}/${String(result.runs)} runs in ${String(result.elapsedMs)}ms · ` +
      `${String(deltas)} deltas coalesced into ${String(result.textEvents)} messages ` +
      `(${String(Math.round((deltas / Math.max(1, result.textEvents)) * 10) / 10)}x) · ` +
      `${String(result.characters)} chars delivered`,
  );
}

async function checkRoster(
  window: BrowserWindow,
  sessionId: string,
  connectionId: string,
): Promise<void> {
  const result = (await evaluate(
    window,
    ROSTER_EXPRESSION(sessionId, connectionId, SMOKE_MODEL_ID),
  )) as RosterResult;

  if (!result || 'error' in result) {
    recordSmokeCheck('renderer-roster', false, result?.error ?? 'no result');
    return;
  }

  {
    const ok =
      result.beforeCount === 0 &&
      result.attachedCount === 1 &&
      result.vendorId === 'ollama' &&
      result.foundEntry &&
      result.weightAfter === 0.5 &&
      result.capAfter === null &&
      result.roleAfter === null &&
      result.detachedCount === 0 &&
      // Detaching removes it from the count, never from the record.
      result.stillListed === 1 &&
      result.refusedUnknownModel;

    recordSmokeCheck(
      'renderer-roster',
      ok,
      `roster ${String(result.beforeCount)} → ${String(result.attachedCount)} → ` +
        `${String(result.detachedCount)} · vendor=${result.vendorId ?? 'none'} · ` +
        `reconfigured to weight ${String(result.weightAfter)} / cap ${String(result.capAfter)} / ` +
        `role ${String(result.roleAfter)} · still listed=${String(result.stillListed)} · ` +
        `unknown model refused=${String(result.refusedUnknownModel)}`,
    );
  }
}

type ChatResult =
  | {
      sawStreaming: boolean;
      frames: number;
      total: number;
      questionAuthor: string | null;
      answerAuthor: string | null;
      answerVendor: string | null;
      finish: string | null;
      text: string;
      matches: boolean;
      hasPromptHash: boolean;
      rendered: boolean;
    }
  | { error: string }
  | undefined;

/**
 * Sends one turn from the conversation pane and checks the answer arrived.
 *
 * The model is re-attached first: the roster check ends by detaching it, and a
 * chat surface must refuse to talk to a model that is not on the roster — which
 * makes attaching it here part of what is being tested.
 */
async function checkChat(
  window: BrowserWindow,
  sessionId: string,
  connectionId: string,
): Promise<void> {
  const attached = await attachModel(window, sessionId, connectionId, SMOKE_MODEL_ID);
  if ('error' in attached) {
    recordSmokeCheck('renderer-chat', false, attached.error);
    return;
  }

  const result = (await evaluate(window, CHAT_EXPRESSION(sessionId, SMOKE_REPLY))) as ChatResult;
  if (!result || 'error' in result) {
    recordSmokeCheck('renderer-chat', false, result?.error ?? 'no result');
    return;
  }

  const ok =
    result.sawStreaming &&
    // More than one frame means the text grew on screen rather than appearing
    // whole: this surface streams, it does not wait and then paste.
    result.frames > 1 &&
    result.questionAuthor === 'HUMAN' &&
    result.answerAuthor === 'MODEL' &&
    result.answerVendor === 'ollama' &&
    result.finish === 'stop' &&
    result.matches &&
    result.hasPromptHash &&
    result.rendered;

  recordSmokeCheck(
    'renderer-chat',
    ok,
    `streamed=${String(result.sawStreaming)} in ${String(result.frames)} frames · ` +
      `${String(result.total)} messages · ${result.questionAuthor ?? 'none'} → ` +
      `${result.answerAuthor ?? 'none'}/${result.answerVendor ?? 'none'} · ` +
      `finish=${result.finish ?? 'none'} · text matches=${String(result.matches)} · ` +
      `prompt hash=${String(result.hasPromptHash)} · rendered=${String(result.rendered)}`,
  );
}

type ConnectionsResult =
  | {
      connectionId: string;
      count: number;
      vaultBackend: string;
      vendorId: string | null;
      hasCredentialRef: boolean;
      replyLeaksSecret: boolean;
      testedHealth: string;
      renamedLabel?: string;
      localProviders: number;
    }
  | { error: string }
  | undefined;

/**
 * Round-trips a connection through the renderer, then checks the two things
 * that matter about it: the key reached the vault, and no byte of it reached
 * the database.
 */
async function checkConnections(window: BrowserWindow): Promise<void> {
  const secret = `sk-sheep-smoke-${randomBytes(16).toString('hex')}`;
  // Registered before the write, so the value is masked even if the write fails
  // and something logs the failure.
  redactor.register(secret);

  try {
    const result = (await evaluate(window, CONNECTIONS_EXPRESSION(secret))) as ConnectionsResult;
    if (!result || 'error' in result) {
      recordSmokeCheck('renderer-connections', false, result?.error ?? 'no result');
      return;
    }

    const isolated = databaseFilesContaining(secret);
    const removal = (await evaluate(window, deleteConnectionExpression(result.connectionId))) as
      { removed: boolean; remaining: number } | { error: string } | undefined;
    const removed = Boolean(removal && !('error' in removal) && removal.removed);

    const ok =
      result.count === 1 &&
      result.vendorId === 'anthropic' &&
      result.hasCredentialRef &&
      !result.replyLeaksSecret &&
      result.renamedLabel === 'Smoke connection (renamed)' &&
      isolated.length === 0 &&
      removed;

    recordSmokeCheck(
      'renderer-connections',
      ok,
      isolated.length > 0
        ? `SECRET FOUND IN ${isolated.join(', ')}`
        : `vault=${result.vaultBackend} · vendor=${result.vendorId ?? 'none'} · ` +
            `test=${result.testedHealth} · local probes=${String(result.localProviders)} · ` +
            `removed=${String(removed)}`,
    );
  } finally {
    redactor.forget(secret);
  }
}

/** The database and its sidecars, filtered to any that hold the given bytes. */
function databaseFilesContaining(needle: string): string[] {
  const store = getStore();
  return [store.path, `${store.path}-wal`, `${store.path}-shm`].filter((path) => {
    try {
      return readFileSync(path).includes(Buffer.from(needle, 'utf8'));
    } catch {
      return false;
    }
  });
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

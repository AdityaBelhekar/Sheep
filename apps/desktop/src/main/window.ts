import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { BrowserWindow, nativeImage, nativeTheme, shell } from 'electron';
import { domainEvent } from '@sheep/core';
import { listSessions } from '@sheep/store';
import { PANE_IDS } from '../shared/panes';
import { APP_NAME } from '../shared/product';
import {
  createArtifact,
  linkArtifact,
  readArtifacts,
  renderArtifact,
  rerenderArtifact,
} from './artifacts';
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
      // See the switches set for a smoke run in index.ts.
      backgroundThrottling: !isSmokeRun,
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

  if (isSmokeRun) {
    // A check that waits on the page says nothing about why the page never got there; the page's own errors do.
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') logWarn('renderer console -', details.message);
    });
    void runRendererSmokeChecks(window);
  }

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

  // Watch for the live turn appearing, so streaming is observed rather than
  // merely inferred from the finished message. Observed, not polled: the whole
  // answer streams in well under a second, and a window that is not in front
  // has its timers throttled to one a second — a poll would sleep through it.
  let sawStreaming = false;
  let frames = 0;
  let lastLength = -1;
  const watcher = new MutationObserver(() => {
    if (pane()?.getAttribute('data-sheep-streaming') !== 'streaming') return;
    sawStreaming = true;
    const live = pane().querySelector('.chat__turn--live .chat__body');
    const length = live ? live.textContent.length : -1;
    if (length !== lastLength) {
      frames += 1;
      lastLength = length;
    }
  });
  watcher.observe(pane(), {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });

  pane().querySelector('[data-sheep-send]').click();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await settle(20);
    if (sawStreaming && pane()?.getAttribute('data-sheep-streaming') !== 'streaming') break;
  }
  watcher.disconnect();

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

/**
 * Drives one FRAMING phase from the renderer, end to end.
 *
 * Only FRAMING: the smoke provider answers in prose, and HYPOTHESIS asks for
 * JSON. Stopping here keeps the check honest about what it proves — the
 * utility process spawned, both directions of the RPC work, a blind-parallel
 * round ran, roles were solved, and the phase parked at its human gate.
 */
const PROTOCOL_EXPRESSION = (sessionId: string): string => `(async () => {
  const before = await window.sheep.invoke('sheep:protocol-state', {
    sessionId: ${JSON.stringify(sessionId)},
  });

  const notices = [];
  const stop = window.sheep.subscribe('sheep:protocol-event', (event) => {
    notices.push(event.kind);
  });

  try {
    const run = await window.sheep.invoke('sheep:protocol-run', {
      sessionId: ${JSON.stringify(sessionId)},
    });
    const framing = run.state.phases[0] ?? null;
    const blind = framing ? (framing.rounds[0] ?? null) : null;

    // Reading the state back goes through the orchestrator again, which
    // rebuilds it from the log: what the run reported and what the log says
    // must be the same thing.
    const after = await window.sheep.invoke('sheep:protocol-state', {
      sessionId: ${JSON.stringify(sessionId)},
    });

    return {
      phasesBefore: before.state.phases.length,
      status: run.status,
      phaseKind: framing ? framing.kind : null,
      phaseStatus: framing ? framing.status : null,
      rounds: framing ? framing.rounds.length : 0,
      blindMode: blind ? blind.mode : null,
      blindSpoke: blind ? blind.spoke.length : 0,
      proposers: blind ? blind.assignments.filter((a) => a.role === 'PROPOSER').length : 0,
      otherRoles: blind
        ? blind.assignments.filter((a) => a.role !== 'PROPOSER').length
        : 0,
      gate: framing && framing.gate ? framing.gate.gate : null,
      proposalLength: framing && framing.gate ? framing.gate.proposal.length : 0,
      reReadPhases: after.state.phases.length,
      reReadGate: after.state.phases[0] && after.state.phases[0].gate
        ? after.state.phases[0].gate.gate
        : null,
      notices: notices.join(','),
    };
  } finally {
    stop();
  }
})()`;

/**
 * The ledger, end to end: a claim recorded from the renderer, an unbacked
 * empirical claim refused by the store's ledger check, and the graph drawn from
 * what came back — then one node selected, to prove the graph is interactive.
 */
const LEDGER_EXPRESSION = `(async () => {
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const created = await window.sheep.invoke('sheep:session-create', {
    title: 'Ledger smoke ' + Date.now(),
    question: 'Can an unbacked empirical claim reach the ledger?',
  });
  const sessionId = created.sessionId;

  const base = await window.sheep.invoke('sheep:claim-record', {
    sessionId,
    claimType: 'CONJECTURE',
    statement: 'Block-sparse attention costs perplexity past 64k tokens.',
    support: [],
  });
  const built = await window.sheep.invoke('sheep:claim-record', {
    sessionId,
    claimType: 'CONJECTURE',
    statement: 'The cost grows with sparsity.',
    support: [{ kind: 'CLAIM', ref: base.claimId }],
  });

  let refusal = 'accepted';
  try {
    await window.sheep.invoke('sheep:claim-record', {
      sessionId,
      claimType: 'EMPIRICAL',
      statement: 'Perplexity rises 0.3 nats at 128k.',
      support: [{ kind: 'ARGUMENT', ref: 'it seems likely' }],
    });
  } catch (error) {
    refusal = String(error && error.message ? error.message : error);
  }
  const after = await window.sheep.invoke('sheep:ledger-get', { sessionId });

  const previous = (await window.sheep.invoke('sheep:settings-read', {})).settings['ui.lastSessionId'];
  await window.sheep.invoke('sheep:settings-write', { key: 'ui.lastSessionId', value: sessionId });
  window.location.hash = '#/ledger';
  let pane = null;
  for (let i = 0; i < 40; i += 1) {
    await settle(50);
    pane = document.querySelector('[data-pane="ledger"][data-sheep-claims]');
    if (pane && pane.querySelectorAll('[data-sheep-node]').length > 0) break;
  }
  const nodes = pane ? pane.querySelectorAll('[data-sheep-node]').length : 0;
  const target = pane ? pane.querySelector('[data-sheep-node="' + built.claimId + '"]') : null;
  if (target) target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  let drawer = null;
  for (let i = 0; i < 40; i += 1) {
    await settle(50);
    drawer = document.querySelector('[data-sheep-provenance="' + built.claimId + '"]');
    if (drawer && drawer.querySelector('[data-sheep-ancestry]')) break;
  }
  const selected = pane ? pane.querySelectorAll('[data-selected="true"]').length : 0;
  const ancestry = drawer?.querySelector('[data-sheep-ancestry]')?.getAttribute('data-sheep-ancestry') ?? null;
  const provenance = await window.sheep.invoke('sheep:claim-provenance', {
    sessionId,
    claimId: built.claimId,
  });
  // Left open for the screenshot; restored by LEDGER_RESTORE_EXPRESSION.
  window.__sheepLedgerPrevious = previous;

  return {
    recorded: after.claims.length,
    edges: built.claims.find((c) => c.claimId === built.claimId).support.length,
    refusal,
    rendered: pane ? pane.getAttribute('data-sheep-claims') : null,
    nodes,
    selected,
    drawerAncestry: ancestry,
    ancestryRoot: provenance.ancestry[0] ? provenance.ancestry[0].claim.claimId === base.claimId : false,
    humanAuthored: provenance.author === null && provenance.message === null,
  };
})()`;

const LEDGER_RESTORE_EXPRESSION = `(async () => {
  await window.sheep.invoke('sheep:settings-write', {
    key: 'ui.lastSessionId',
    value: window.__sheepLedgerPrevious ?? null,
  });
  window.location.hash = '#/sessions';
  await new Promise((resolve) => setTimeout(resolve, 60));
  return true;
})()`;

/**
 * The Lab, end to end, through the same channels the pane uses.
 *
 * One script runs clean and leaves a figure; an EMPIRICAL claim then rests on
 * it. A second reaches for the network: it is refused inside the sandbox,
 * recorded as failed, and refused again by the ledger as backing. Then the
 * pane itself is opened — editor, history, the recorded output, the figure.
 *
 * The scripts avoid matplotlib on purpose: its first import builds a font
 * cache, and this check starts from an empty data directory every time.
 */
const LAB_EXPRESSION = `(async () => {
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const status = await window.sheep.invoke('sheep:lab-status', {});
  if (!status.available) return { error: 'sandbox unavailable: ' + status.detail };

  const created = await window.sheep.invoke('sheep:session-create', {
    title: 'Lab smoke ' + Date.now(),
    question: 'Does a result reach the ledger as a hashed artifact?',
  });
  const sessionId = created.sessionId;

  const ended = new Map();
  const output = new Map();
  const stop = window.sheep.subscribe('sheep:lab-event', (event) => {
    if (event.kind === 'output') {
      output.set(event.runId, (output.get(event.runId) ?? '') + event.data);
    } else {
      ended.set(event.runId, event);
    }
  });
  const run = async (lines) => {
    const { runId } = await window.sheep.invoke('sheep:lab-run', {
      sessionId,
      code: lines.join('\\n'),
      seed: 7,
    });
    for (let i = 0; i < 300 && !ended.has(runId); i += 1) await settle(50);
    return { runId, end: ended.get(runId) ?? null, output: output.get(runId) ?? '' };
  };
  const claim = async (runId) => {
    try {
      await window.sheep.invoke('sheep:claim-record', {
        sessionId,
        claimType: 'EMPIRICAL',
        statement: 'The mean of 0..4 is 2.',
        support: [{ kind: 'EXECUTION', ref: runId }],
      });
      return 'accepted';
    } catch (error) {
      return String(error && error.message ? error.message : error);
    }
  };

  try {
    const clean = await run([
      'import numpy as np',
      'print("mean", float(np.arange(5).mean()), np.random.default_rng().integers(1000))',
      'svg = \\'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>\\'',
      'open("chart.svg", "w").write(svg)',
    ]);
    const again = await run([
      'import numpy as np',
      'print("mean", float(np.arange(5).mean()), np.random.default_rng().integers(1000))',
    ]);
    const escape = await run([
      'import socket',
      'socket.create_connection(("1.1.1.1", 80), timeout=5)',
      'print("ESCAPED")',
    ]);
    const backed = await claim(clean.runId);
    const unbacked = await claim(escape.runId);
    const listed = await window.sheep.invoke('sheep:executions-list', { sessionId });

    const previous = (await window.sheep.invoke('sheep:settings-read', {})).settings['ui.lastSessionId'];
    window.__sheepLedgerPrevious = previous;
    await window.sheep.invoke('sheep:settings-write', { key: 'ui.lastSessionId', value: sessionId });
    window.location.hash = '#/lab';

    let pane = null;
    for (let i = 0; i < 200; i += 1) {
      await settle(50);
      pane = document.querySelector('[data-pane="lab"][data-sheep-runs="3"]');
      if (pane && pane.querySelector('[data-sheep-editor="ready"] .monaco-editor')) break;
    }
    const editor = Boolean(pane && pane.querySelector('[data-sheep-editor="ready"] .monaco-editor'));
    const row = pane ? pane.querySelector('[data-sheep-run="' + clean.runId + '"]') : null;
    if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    let shown = '';
    let plot = null;
    for (let i = 0; i < 100; i += 1) {
      await settle(50);
      shown = pane?.querySelector('[data-sheep-lab-output]')?.textContent ?? '';
      plot = pane?.querySelector('img[data-sheep-plot]') ?? null;
      if (shown.includes('mean') && plot && plot.complete && plot.naturalWidth > 0) break;
    }

    return {
      python: status.python,
      cleanStatus: clean.end && clean.end.kind === 'end' ? clean.end.execution.status : (clean.end ? clean.end.message : 'no end'),
      streamed: clean.output,
      repeated: again.output === clean.output && clean.output !== '',
      artifacts: clean.end && clean.end.kind === 'end' ? clean.end.execution.artifacts.map((a) => a.path) : [],
      escapeStatus: escape.end && escape.end.kind === 'end' ? escape.end.execution.status : 'no end',
      escapeContained: escape.output.includes('network access is not allowed') && !escape.output.includes('ESCAPED'),
      backed,
      unbacked,
      listed: listed.executions.length,
      backing: listed.backing.length === 1 && listed.backing[0].executionId === clean.runId,
      runs: pane ? pane.getAttribute('data-sheep-runs') : null,
      editor,
      shown,
      plotWidth: plot ? plot.naturalWidth : 0,
    };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  } finally {
    stop();
  }
})()`;

/**
 * Verification, end to end, through the channels the pane uses.
 *
 * One derivation is sound and a DERIVED claim then rests on it. The other has
 * a step that follows, a planted error, and a step no checker can decide: the
 * three must come back PASS, FAIL and UNCHECKABLE in that order, and the
 * ledger must refuse it as backing. Then the pane is opened on the second, to
 * prove the undecided step is on screen and labelled.
 */
const VERIFICATION_EXPRESSION = `(async () => {
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const created = await window.sheep.invoke('sheep:session-create', {
    title: 'Verification smoke ' + Date.now(),
    question: 'Is a planted error caught, and an undecided step labelled?',
  });
  const sessionId = created.sessionId;
  const check = (derivation) =>
    window.sheep.invoke('sheep:derivation-check', { sessionId, derivation });
  const claim = async (derivationId) => {
    try {
      await window.sheep.invoke('sheep:claim-record', {
        sessionId,
        claimType: 'DERIVED',
        statement: 'Work done is half the mass times the speed squared.',
        support: [{ kind: 'DERIVATION', ref: derivationId }],
      });
      return 'accepted';
    } catch (error) {
      return String(error && error.message ? error.message : error);
    }
  };

  try {
    const sound = await check({
      title: 'Kinetic energy',
      symbols: { W: { units: 'joule' }, F: { units: 'newton' }, d: { units: 'm' }, m: { units: 'kg' }, a: { units: 'm/s**2' } },
      given: [
        { id: 'g1', statement: 'W = F*d' },
        { id: 'g2', statement: 'F = m*a' },
      ],
      steps: [{ id: 's1', statement: 'W = m*a*d', operation: 'substitute', from: 'g1', using: 'g2' }],
    });
    const flawed = await check({
      title: 'A planted error',
      given: [{ id: 'g1', statement: 'y = (x + 1)**2' }],
      steps: [
        { id: 's1', statement: 'y = x**2 + 2*x + 1', operation: 'expand' },
        { id: 's2', statement: 'Derivative(y, x) = 2*x - 2', operation: 'differentiate', args: { var: 'x' } },
        { id: 's3', statement: 'y = x**2 + 2*x + 1', operation: 'by inspection', from: 'g1' },
      ],
    });
    const backed = await claim(sound.record.derivationId);
    const unbacked = await claim(flawed.record.derivationId);

    const previous = (await window.sheep.invoke('sheep:settings-read', {})).settings['ui.lastSessionId'];
    window.__sheepLedgerPrevious = previous;
    await window.sheep.invoke('sheep:settings-write', { key: 'ui.lastSessionId', value: sessionId });
    window.location.hash = '#/verification';

    let pane = null;
    let row = null;
    for (let i = 0; i < 100; i += 1) {
      await settle(50);
      pane = document.querySelector('[data-pane="verification"][data-sheep-derivations="2"]');
      row = pane ? pane.querySelector('[data-sheep-derivation="' + flawed.record.derivationId + '"]') : null;
      if (row) break;
    }
    if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    let rows = [];
    for (let i = 0; i < 100; i += 1) {
      await settle(50);
      rows = pane ? [...pane.querySelectorAll('tr[data-sheep-step]')] : [];
      if (rows.length === 3) break;
    }
    const undecided = rows.find((entry) => entry.getAttribute('data-status') === 'UNCHECKABLE');

    return {
      sound: sound.verdict.status,
      soundUnits: sound.verdict.steps[0].dimensions ? sound.verdict.steps[0].dimensions.status : 'none',
      flawed: flawed.verdict.steps.map((step) => step.status).join(','),
      method: flawed.verdict.steps[1].method,
      backed,
      unbacked,
      listed: pane ? pane.getAttribute('data-sheep-derivations') : null,
      shown: rows.map((entry) => entry.getAttribute('data-status')).join(','),
      undecidedVisible: Boolean(undecided && undecided.getBoundingClientRect().height > 0),
      undecidedText: undecided ? undecided.textContent : '',
      typeset: pane ? pane.querySelectorAll('math').length : 0,
      fractionDrawn: pane ? pane.querySelectorAll('math msup, math mrow').length > 0 : false,
    };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
})()`;

/**
 * Drives the Artifacts pane as a person would: renders the starter diagram with
 * the pane's own button, opens a TikZ figure that exists only as a PDF, renders
 * it again from source, and reads back the claim that cites it.
 */
const ARTIFACTS_EXPRESSION = `(async () => {
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (probe, seconds = 20) => {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      const found = probe();
      if (found) return found;
      await settle(50);
    }
    return null;
  };
  const click = (element) => element && element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  try {
    const created = await window.sheep.invoke('sheep:session-create', {
      title: 'Artifacts smoke ' + Date.now(),
      question: 'Can every figure be traced to what made it?',
    });
    const sessionId = created.sessionId;
    const status = await window.sheep.invoke('sheep:artifacts-status', {});
    const tikz = await window.sheep.invoke('sheep:artifact-create', {
      sessionId,
      kind: 'tikz',
      title: 'Smoke picture',
      source: String.raw\`\\draw[->] (0,0) -- node[above] {backs} (3,0);\`,
    });
    const tikzId = tikz.created[0];
    const claim = await window.sheep.invoke('sheep:claim-record', {
      sessionId,
      claimType: 'CONJECTURE',
      statement: 'The arrow points from evidence to claim.',
      support: [{ kind: 'ARTIFACT', ref: tikzId }],
    });
    let refused = 'accepted';
    try {
      await window.sheep.invoke('sheep:artifact-create', {
        sessionId, kind: 'graphviz', title: 'Broken', source: 'digraph { a -> }',
      });
    } catch (error) {
      refused = String(error && error.message ? error.message : error);
    }

    const previous = (await window.sheep.invoke('sheep:settings-read', {})).settings['ui.lastSessionId'];
    window.__sheepLedgerPrevious = previous;
    await window.sheep.invoke('sheep:settings-write', { key: 'ui.lastSessionId', value: sessionId });
    window.location.hash = '#/artifacts';

    const pane = await until(() => document.querySelector('[data-pane="artifacts"][data-sheep-artifacts="1"]'));
    if (!pane) return { error: 'the pane never listed the artifact' };

    // The pane's own button, on the starter source it opens with.
    click(pane.querySelector('[data-sheep-artifact-render]'));
    await until(() => pane.getAttribute('data-sheep-artifacts') === '2');
    const image = await until(() => {
      const img = pane.querySelector('[data-sheep-artifact-image]');
      return img && img.complete && img.naturalWidth > 0 ? img : null;
    });

    click(pane.querySelector('[data-sheep-artifact="' + tikzId + '"]'));
    const canvas = await until(() => pane.querySelector('[data-sheep-pdf] canvas'));
    const linked = pane.querySelector('[data-sheep-artifact-claims]');
    const sourceShown = await until(() => {
      const shown = pane.querySelector('[data-sheep-artifact-source-shown]');
      return shown && shown.textContent.includes('draw') ? shown.textContent : null;
    });

    click(pane.querySelector('[data-sheep-artifact-rerender]'));
    const verdict = await until(() => pane.querySelector('[data-sheep-artifact-identical]'));

    return {
      tools: status.available ? status.detail : 'unavailable: ' + status.detail,
      refused,
      listed: pane.getAttribute('data-sheep-artifacts'),
      kinds: [...pane.querySelectorAll('[data-sheep-artifact]')].map((row) => row.getAttribute('data-kind')).join(','),
      imageWidth: image ? image.naturalWidth : 0,
      pdfWidth: canvas ? canvas.width : 0,
      claims: linked ? linked.getAttribute('data-sheep-artifact-claims') : null,
      claimShown: linked ? linked.textContent.includes(claim.claimId.slice(0, 8)) : false,
      sourceShown: Boolean(sourceShown),
      identical: verdict ? verdict.getAttribute('data-sheep-artifact-identical') : null,
    };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
})()`;

/**
 * Compiles a paper from the pane, as a person would: a session with a claim and
 * a figure the claim cites, the default template, the Compile button, and then
 * the pages drawn on screen. Then the bundle, exported with the pane's button.
 */
const PAPER_EXPRESSION = `(async () => {
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (probe, seconds = 40) => {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      const found = probe();
      if (found) return found;
      await settle(50);
    }
    return null;
  };
  const click = (element) => element && element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  try {
    const created = await window.sheep.invoke('sheep:session-create', {
      title: 'Paper smoke: 100% of it & then some',
      question: 'Does a compiled paper say only what its ledger holds?',
    });
    const sessionId = created.sessionId;
    const graph = await window.sheep.invoke('sheep:artifact-create', {
      sessionId,
      kind: 'graphviz',
      title: 'Ledger to paper',
      source: 'digraph { rankdir=LR; ledger -> document -> paper }',
    });
    await window.sheep.invoke('sheep:claim-record', {
      sessionId,
      claimType: 'CONJECTURE',
      statement: 'A paper built from the ledger cannot say more than the ledger_does {ever}.',
      support: [{ kind: 'ARTIFACT', ref: graph.created[0] }],
    });
    const listed = await window.sheep.invoke('sheep:paper-templates', {});

    const previous = (await window.sheep.invoke('sheep:settings-read', {})).settings['ui.lastSessionId'];
    window.__sheepLedgerPrevious = previous;
    await window.sheep.invoke('sheep:settings-write', { key: 'ui.lastSessionId', value: sessionId });
    window.location.hash = '#/paper';

    const pane = await until(() => {
      const found = document.querySelector('[data-pane="paper"]');
      return found && found.querySelector('[data-sheep-paper-compile]:not([disabled])') ? found : null;
    });
    if (!pane) return { error: 'the pane never offered to compile' };
    const offered = [...pane.querySelectorAll('[data-sheep-paper-template]')].map((tab) =>
      tab.getAttribute('data-sheep-paper-template'),
    );

    click(pane.querySelector('[data-sheep-paper-compile]'));
    await until(() => pane.getAttribute('data-sheep-paper'));
    const drawn = await until(() => pane.querySelector('[data-sheep-pdf]'), 10);
    const summary = pane.querySelector('[data-sheep-paper-summary]');
    const canvas = pane.querySelector('[data-sheep-pdf] canvas');

    click(pane.querySelector('[data-sheep-paper-export]'));
    const exported = await until(() => pane.querySelector('[data-sheep-paper-exported]'));

    return {
      exported: exported ? exported.getAttribute('data-sheep-paper-exported') : null,
      exportedText: exported ? exported.textContent : '',
      engine: listed.available ? listed.detail : 'unavailable: ' + listed.detail,
      offered: offered.join(','),
      state: pane.getAttribute('data-sheep-paper'),
      problems: [...pane.querySelectorAll('[data-sheep-paper-problem]')].map((entry) => entry.textContent).join(' | '),
      pages: drawn ? Number(drawn.getAttribute('data-sheep-pdf')) : 0,
      pageWidth: canvas ? canvas.width : 0,
      summary: summary ? summary.textContent : '',
    };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
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
  await checkLedger(window);
  await checkLab(window);
  await checkVerification(window);
  await checkArtifactRendering();
  await checkArtifactsPane(window);
  await checkPaperPane(window);
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

async function checkLedger(window: BrowserWindow): Promise<void> {
  const result = (await evaluate(window, LEDGER_EXPRESSION)) as
    | {
        recorded: number;
        edges: number;
        refusal: string;
        rendered: string | null;
        nodes: number;
        selected: number;
        drawerAncestry: string | null;
        ancestryRoot: boolean;
        humanAuthored: boolean;
      }
    | { error: string }
    | undefined;
  // Let the drawer's reply reach a painted frame before capturing it.
  await delay(250);
  await captureScreenshot(window, 'ledger');
  await evaluate(window, LEDGER_RESTORE_EXPRESSION);

  if (!result || 'error' in result) {
    recordSmokeCheck('renderer-ledger', false, result?.error ?? 'no result');
    return;
  }

  const ok =
    result.recorded === 2 &&
    result.edges === 1 &&
    result.refusal.includes('LEDGER_EMPIRICAL_WITHOUT_EXECUTION') &&
    result.rendered === '2' &&
    result.nodes === 2 &&
    result.selected === 1 &&
    result.drawerAncestry === '1' &&
    result.ancestryRoot &&
    result.humanAuthored;

  recordSmokeCheck(
    'renderer-ledger',
    ok,
    `${String(result.recorded)} claims recorded · unbacked empirical → ${
      result.refusal.match(/LEDGER_[A-Z_]+/)?.[0] ?? result.refusal
    } · graph ${String(result.nodes)} nodes, ${String(result.selected)} selected · drawer ancestry ${
      result.drawerAncestry ?? 'none'
    }`,
  );
}

async function checkLab(window: BrowserWindow): Promise<void> {
  const result = (await evaluate(window, LAB_EXPRESSION)) as
    | {
        python: string | null;
        cleanStatus: string;
        streamed: string;
        repeated: boolean;
        artifacts: string[];
        escapeStatus: string;
        escapeContained: boolean;
        backed: string;
        unbacked: string;
        listed: number;
        backing: boolean;
        runs: string | null;
        editor: boolean;
        shown: string;
        plotWidth: number;
      }
    | { error: string }
    | undefined;
  await delay(250);
  await captureScreenshot(window, 'lab');
  await evaluate(window, LEDGER_RESTORE_EXPRESSION);

  if (!result || 'error' in result) {
    recordSmokeCheck('renderer-lab', false, result?.error ?? 'no result');
    return;
  }

  const ok =
    result.cleanStatus === 'ok' &&
    result.streamed.startsWith('mean 2.0') &&
    result.repeated &&
    result.artifacts.join() === 'chart.svg' &&
    result.escapeStatus === 'error' &&
    result.escapeContained &&
    result.backed === 'accepted' &&
    result.unbacked.includes('LEDGER_FAILED_EXECUTION') &&
    result.listed === 3 &&
    result.backing &&
    result.runs === '3' &&
    result.editor &&
    result.shown.includes('mean 2.0') &&
    result.plotWidth === 40;

  recordSmokeCheck(
    'renderer-lab',
    ok,
    `python ${result.python ?? '?'} · run=${result.cleanStatus} · streamed=${JSON.stringify(
      result.streamed.trim(),
    )} · same seed same output=${String(result.repeated)} · artifacts=${result.artifacts.join()} · network attempt=${
      result.escapeStatus
    } contained=${String(result.escapeContained)} · claim on clean run=${result.backed} · on failed run → ${
      result.unbacked.match(/LEDGER_[A-Z_]+/)?.[0] ?? result.unbacked
    } · pane runs=${result.runs ?? 'none'} · monaco=${String(result.editor)} · plot ${String(
      result.plotWidth,
    )}px`,
  );
}

const SMOKE_MERMAID = `flowchart LR
  H[Hypothesis] --> M{Method}
  M -->|run| E[(Execution)]
  E --> C[Claim]
`;

const SMOKE_GRAPH = 'digraph { rankdir=LR; execution -> claim [label="backs"]; }';

const SMOKE_TIKZ = String.raw`\node[draw] (a) {Claim};
\node[draw, right=of a] (b) {Evidence};
\draw[-{Stealth}] (b) -- (a);`;

const SMOKE_FORMULA = String.raw`W = \frac{m v^{2}}{2}`;

const SMOKE_PLOT = [
  'import numpy as np',
  'import matplotlib.pyplot as plt',
  'plt.plot(np.cumsum(np.random.default_rng().normal(size=50)))',
  'plt.title("Smoke walk")',
].join('\n');

/**
 * Renders one artifact of every kind and proves what an artifact is for: the
 * same source gives the same bytes when asked again; what is recorded is in
 * the content-addressed store with its source; a figure deleted from the store
 * comes back byte for byte from that source alone; and a figure knows which
 * claims rest on it.
 *
 * Mermaid can only be checked here. It is rendered by Chromium, in a window,
 * and there is neither in the unit tests.
 */
async function checkArtifactRendering(): Promise<void> {
  const digest = (outputs: readonly { data: Uint8Array }[]): string =>
    outputs.map(({ data }) => createHash('sha256').update(data).digest('hex')).join();

  try {
    const store = getStore();
    const [session] = listSessions(store.db);
    if (!session) throw new Error('no session to record an artifact in');
    const { sessionId } = session;

    const first = await renderArtifact('mermaid', SMOKE_MERMAID);
    // A PDF stamped with the clock would differ across a second boundary.
    await delay(1_100);
    const second = await renderArtifact('mermaid', SMOKE_MERMAID);
    const repeatable = digest(first.outputs) === digest(second.outputs);

    const records = [
      ...(await createArtifact({
        sessionId,
        kind: 'mermaid',
        title: 'Smoke flowchart',
        source: SMOKE_MERMAID,
      })),
      ...(await createArtifact({
        sessionId,
        kind: 'graphviz',
        title: 'Smoke graph',
        source: SMOKE_GRAPH,
      })),
      ...(await createArtifact({
        sessionId,
        kind: 'tikz',
        title: 'Smoke picture',
        source: SMOKE_TIKZ,
      })),
      ...(await createArtifact({
        sessionId,
        kind: 'formula',
        title: 'Kinetic energy',
        source: SMOKE_FORMULA,
      })),
      ...(await createArtifact({
        sessionId,
        kind: 'matplotlib',
        title: 'Smoke walk',
        source: SMOKE_PLOT,
      })),
    ];
    const refused = await renderArtifact('mermaid', 'flowchart LR; A --').then(
      () => 'rendered',
      (error: unknown) => (error instanceof Error ? error.name : String(error)),
    );

    const stored = records.every(
      (record) =>
        store.blobs.has(record.sourceHash) &&
        record.outputs.every((output) => store.blobs.has(output.hash)),
    );
    // Delete a rendering of each from the store, then ask for it again.
    let regenerated = 0;
    for (const record of records) {
      const lost = record.outputs[0]?.hash ?? '';
      rmSync(store.blobs.pathFor(lost));
      const result = await rerenderArtifact(record.artifactId);
      if (result.identical && result.files[0]?.restored && store.blobs.verify(lost)) {
        regenerated += 1;
      }
    }

    // One claim cites the graph; another rests on the run that drew the plot.
    const [cited, measured] = [randomUUID(), randomUUID()];
    const graphRecord = records[1];
    const plotRecord = records.at(-1);
    store.record([
      domainEvent('claim.recorded', {
        sessionId,
        claimId: cited,
        claimType: 'CONJECTURE',
        statement: 'Evidence flows from a run to the claim it backs.',
      }),
      domainEvent('claim.recorded', {
        sessionId,
        claimId: measured,
        claimType: 'EMPIRICAL',
        statement: 'The walk drifts from its origin.',
        support: [{ kind: 'EXECUTION', ref: plotRecord?.executionId ?? '' }],
      }),
    ]);
    linkArtifact(sessionId, graphRecord?.artifactId ?? '', cited);
    const orphan = (() => {
      try {
        linkArtifact(sessionId, randomUUID(), cited);
        return 'accepted';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    const { backing } = readArtifacts(sessionId);
    const claimsOn = (artifactId: string | undefined): string =>
      (backing.find((entry) => entry.artifactId === artifactId)?.claimIds ?? []).join();
    const linked =
      claimsOn(graphRecord?.artifactId) === cited &&
      claimsOn(plotRecord?.artifactId) === measured &&
      orphan.includes('LEDGER_UNKNOWN_ARTIFACT');

    const shape = records
      .map((record) => `${record.kind}:${record.outputs.map((o) => o.path).join('+')}`)
      .join(' ');
    const mermaid = records[0];
    const figure = records.at(-1);
    const svg = mermaid ? store.blobs.readText(mermaid.outputs[0]?.hash ?? '') : '';
    const ok =
      repeatable &&
      stored &&
      regenerated === records.length &&
      linked &&
      refused === 'RenderError' &&
      svg.includes('Hypothesis') &&
      !svg.includes('foreignObject') &&
      figure?.executionId != null &&
      shape ===
        'mermaid:diagram.svg+diagram.pdf graphviz:diagram.svg+diagram.pdf tikz:figure.pdf formula:formula.pdf matplotlib:figure-1.svg+figure-1.pdf';

    recordSmokeCheck(
      'artifacts-render',
      ok,
      `${mermaid?.toolchain ?? '?'} · same source same bytes=${String(repeatable)} · ${shape} · figure backed by a run=${String(figure?.executionId != null)} · in store=${String(stored)} · deleted and regenerated byte-identical=${String(regenerated)}/${String(records.length)} · claims linked=${String(linked)} · unreadable diagram → ${refused}`,
    );
  } catch (error) {
    recordSmokeCheck(
      'artifacts-render',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function checkArtifactsPane(window: BrowserWindow): Promise<void> {
  const result = (await evaluate(window, ARTIFACTS_EXPRESSION)) as
    | {
        tools: string;
        refused: string;
        listed: string | null;
        kinds: string;
        imageWidth: number;
        pdfWidth: number;
        claims: string | null;
        claimShown: boolean;
        sourceShown: boolean;
        identical: string | null;
      }
    | { error: string }
    | undefined;
  await delay(250);
  await captureScreenshot(window, 'artifacts');
  await evaluate(window, LEDGER_RESTORE_EXPRESSION);

  if (!result || 'error' in result) {
    recordSmokeCheck('renderer-artifacts', false, result?.error ?? 'no result');
    return;
  }

  const ok =
    result.refused.includes('syntax error') &&
    result.listed === '2' &&
    result.kinds === 'graphviz,tikz' &&
    result.imageWidth > 0 &&
    result.pdfWidth > 0 &&
    result.claims === '1' &&
    result.claimShown &&
    result.sourceShown &&
    result.identical === 'true';

  recordSmokeCheck(
    'renderer-artifacts',
    ok,
    `${result.tools} · unreadable graph refused=${String(
      result.refused.includes('syntax error'),
    )} · pane lists ${result.listed ?? 'none'} (${result.kinds}) · rendered from the pane: svg ${String(
      result.imageWidth,
    )}px · tikz pdf drawn ${String(result.pdfWidth)}px · source shown=${String(
      result.sourceShown,
    )} · claims on figure=${result.claims ?? 'none'} · re-render identical=${result.identical ?? 'none'}`,
  );
}

async function checkPaperPane(window: BrowserWindow): Promise<void> {
  const result = (await evaluate(window, PAPER_EXPRESSION)) as
    | {
        engine: string;
        offered: string;
        state: string | null;
        problems: string;
        pages: number;
        pageWidth: number;
        summary: string;
        exported: string | null;
        exportedText: string;
      }
    | { error: string }
    | undefined;
  await delay(250);
  await captureScreenshot(window, 'paper');
  await evaluate(window, LEDGER_RESTORE_EXPRESSION);

  if (!result || 'error' in result) {
    recordSmokeCheck('renderer-paper', false, result?.error ?? 'no result');
    return;
  }

  const ok =
    result.offered.split(',').includes('sheep') &&
    result.state === 'compiled' &&
    // The record and its provenance appendix do not fit on one page.
    result.pages >= 2 &&
    result.pageWidth > 0 &&
    result.exported === 'true' &&
    /Saved \d+ files .*sheep-record-[0-9a-f]{8}-sheep\.zip/.test(result.exportedText) &&
    result.summary.includes('1 claim') &&
    result.summary.includes('1 figure');

  recordSmokeCheck(
    'renderer-paper',
    ok,
    `${result.engine} · templates ${result.offered} · ${result.state ?? 'no result'}${
      result.problems === '' ? '' : ` (${result.problems})`
    } · ${String(result.pages)} page(s) drawn at ${String(result.pageWidth)}px · ${result.summary} · bundle ${
      result.exported === 'true' ? result.exportedText.replace(/ to .*$/, '') : 'not exported'
    }`,
  );
}

async function checkVerification(window: BrowserWindow): Promise<void> {
  const result = (await evaluate(window, VERIFICATION_EXPRESSION)) as
    | {
        sound: string;
        soundUnits: string;
        flawed: string;
        method: string;
        backed: string;
        unbacked: string;
        listed: string | null;
        shown: string;
        undecidedVisible: boolean;
        undecidedText: string;
        typeset: number;
        fractionDrawn: boolean;
      }
    | { error: string }
    | undefined;
  await delay(250);
  await captureScreenshot(window, 'verification');
  await evaluate(window, LEDGER_RESTORE_EXPRESSION);

  if (!result || 'error' in result) {
    recordSmokeCheck('renderer-verification', false, result?.error ?? 'no result');
    return;
  }

  const ok =
    result.sound === 'PASS' &&
    result.soundUnits === 'PASS' &&
    result.flawed === 'PASS,FAIL,UNCHECKABLE' &&
    result.backed === 'accepted' &&
    result.unbacked.includes('LEDGER_FAILED_DERIVATION') &&
    result.listed === '2' &&
    result.shown === 'PASS,FAIL,UNCHECKABLE' &&
    result.undecidedVisible &&
    result.undecidedText.includes('UNCHECKABLE') &&
    result.undecidedText.includes('no checker for the operation') &&
    result.typeset >= 4 &&
    result.fractionDrawn;

  recordSmokeCheck(
    'renderer-verification',
    ok,
    `sound derivation=${result.sound} units=${result.soundUnits} · planted error → ${
      result.flawed
    } (caught by ${result.method}) · DERIVED claim on sound=${result.backed} · on flawed → ${
      result.unbacked.match(/LEDGER_[A-Z_]+/)?.[0] ?? result.unbacked
    } · pane rows=${result.shown} · undecided step shown and labelled=${String(
      result.undecidedVisible && result.undecidedText.includes('UNCHECKABLE'),
    )} · ${String(result.typeset)} formulas typeset`,
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
    await checkProtocol(window, session.sessionId, connection.connectionId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const name of [
      'renderer-roster',
      'renderer-chat',
      'stream-cancel',
      'stream-concurrency',
      'orchestrator-protocol',
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

type ProtocolResult =
  | {
      phasesBefore: number;
      status: string;
      phaseKind: string | null;
      phaseStatus: string | null;
      rounds: number;
      blindMode: string | null;
      blindSpoke: number;
      proposers: number;
      otherRoles: number;
      gate: string | null;
      proposalLength: number;
      reReadPhases: number;
      reReadGate: string | null;
      notices: string;
    }
  | { error: string }
  | undefined;

/**
 * Runs the protocol against a real orchestrator process.
 *
 * Everything here is the shipping path: the utility process is forked, the
 * phase is driven over JSON-RPC, the turns go through the gateway to the smoke
 * provider, and the events land in the same log every other check reads.
 */
async function checkProtocol(
  window: BrowserWindow,
  sessionId: string,
  connectionId: string,
): Promise<void> {
  const attached = await attachModel(window, sessionId, connectionId, SMOKE_MODEL_ID);
  if ('error' in attached) {
    recordSmokeCheck('orchestrator-protocol', false, attached.error);
    return;
  }

  const result = (await evaluate(window, PROTOCOL_EXPRESSION(sessionId))) as ProtocolResult;
  if (!result || 'error' in result) {
    recordSmokeCheck('orchestrator-protocol', false, result?.error ?? 'no result');
    return;
  }

  const ok =
    result.phasesBefore === 0 &&
    result.status === 'awaiting-approval' &&
    result.phaseKind === 'FRAMING' &&
    result.phaseStatus === 'awaiting-approval' &&
    // One blind round of statements, one sequential round for the charter.
    result.rounds === 2 &&
    result.blindMode === 'BLIND_PARALLEL' &&
    // Every attached model proposes, independently, and nothing else is
    // assigned in a framing round — however many the earlier checks left behind.
    result.proposers > 0 &&
    result.otherRoles === 0 &&
    result.blindSpoke === result.proposers &&
    result.gate === 'charter' &&
    result.proposalLength > 0 &&
    // Read back through a second RPC round trip: the state is in the log, not
    // in the reply that reported it.
    result.reReadPhases === 1 &&
    result.reReadGate === 'charter' &&
    result.notices.includes('gate-raised');

  recordSmokeCheck(
    'orchestrator-protocol',
    ok,
    `${result.phaseKind ?? 'none'} ${result.phaseStatus ?? 'none'} · ` +
      `${String(result.rounds)} rounds · blind ${result.blindMode ?? 'none'} ` +
      `(${String(result.blindSpoke)}/${String(result.proposers)} proposers spoke) · ` +
      `gate=${result.gate ?? 'none'} (${String(result.proposalLength)} chars) · ` +
      `re-read=${result.reReadGate ?? 'none'} · progress=${result.notices || 'none'}`,
  );
}

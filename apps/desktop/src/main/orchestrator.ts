import { join } from 'node:path';
import { app, BrowserWindow, utilityProcess, type UtilityProcess } from 'electron';
import { safeParseDomainEvent, type DomainEvent } from '@sheep/core';
import {
  RpcPeer,
  type ApproveInput,
  type ProgressUpdate,
  type ProtocolView,
  type RunOutcome,
  type RpcTransport,
  type SessionSnapshot,
  type TurnRequest,
} from '@sheep/orchestrator';
import { getSession, listParticipants } from '@sheep/store';
import { logError, logInfo, logWarn } from './log';
import { recordSmokeCheck } from './smoke';
import { getStore } from './store';
import { runTurn } from './turn';

/**
 * Main's half of the orchestrator: spawn it, serve it, restart it.
 *
 * The child is the only thing in Sheep that can drive a session, and main is
 * the only thing that can write to the log or call a provider — so this module
 * is the whole boundary between them. Three rules keep it honest:
 *
 * - **The child is disposable.** It holds no state that is not in the log, so
 *   a crash costs the turn that was in flight and nothing else; the next call
 *   spawns a fresh one, which resumes from what was committed.
 * - **Events are re-validated on the way in.** The child is our own code, but
 *   it is across a process boundary, and anything that reaches the hash chain
 *   is parsed against the schema first regardless of who sent it.
 * - **Progress is advisory.** It is forwarded to whatever window is open and
 *   dropped if none is. Nothing waits for it.
 */

let child: UtilityProcess | undefined;
let peer: RpcPeer | undefined;
let starting: Promise<RpcPeer> | undefined;
let restarts = 0;

/** How many times a repeatedly crashing child is respawned before giving up. */
const MAX_RESTARTS = 5;

function entryPath(): string {
  // electron-vite emits every main-process bundle side by side, so the child's
  // entry sits next to this one whether the app is packaged or not.
  return join(app.getAppPath(), 'out', 'main', 'orchestrator.js');
}

/** Spawns the orchestrator if it is not already running. */
export async function startOrchestrator(): Promise<RpcPeer> {
  if (peer && !peer.closed) return peer;
  if (starting) return await starting;

  starting = spawn().finally(() => {
    starting = undefined;
  });
  return await starting;
}

async function spawn(): Promise<RpcPeer> {
  const forked = utilityProcess.fork(entryPath(), [], {
    serviceName: 'sheep-orchestrator',
    stdio: 'pipe',
  });
  child = forked;

  forked.stdout?.on('data', (chunk: Buffer) => {
    logInfo(`orchestrator: ${chunk.toString().trimEnd()}`);
  });
  forked.stderr?.on('data', (chunk: Buffer) => {
    logWarn(`orchestrator: ${chunk.toString().trimEnd()}`);
  });

  const transport: RpcTransport = {
    post(message) {
      forked.postMessage(message);
    },
    onMessage(listener) {
      forked.on('message', (message: unknown) => {
        listener(message);
      });
    },
  };

  const connected = new RpcPeer(transport, { handlers: HANDLERS });
  peer = connected;

  forked.on('exit', (code) => {
    // Every call still in flight is rejected rather than left hanging: a phase
    // waiting on a process that no longer exists would wait forever.
    connected.close(`the orchestrator exited with code ${String(code)}`);
    if (child === forked) {
      child = undefined;
      peer = undefined;
    }
    if (code !== 0) {
      restarts += 1;
      logWarn(`the orchestrator exited with code ${String(code)}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the orchestrator did not start'));
    }, 10_000);
    forked.once('spawn', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const ping = await connected.call<{ pid: number }>('ping');
  logInfo(`orchestrator ready (pid ${String(ping.pid)})`);
  recordSmokeCheck('orchestrator-ready', true, `pid=${String(ping.pid)}`);
  return connected;
}

/** Ends the child. Called on quit; a session resumes from the log next launch. */
export function stopOrchestrator(): void {
  peer?.close('the app is quitting');
  child?.kill();
  child = undefined;
  peer = undefined;
}

async function call<T>(method: string, params: unknown): Promise<T> {
  const connection = await startOrchestrator();
  try {
    return await connection.call<T>(method, params);
  } catch (error) {
    // One retry, and only when the child died: a spawned replacement resumes
    // from the log, so the worst case is repeating the turn that was lost.
    if (connection.closed && restarts <= MAX_RESTARTS) {
      logWarn('retrying against a fresh orchestrator -', error);
      return await (await startOrchestrator()).call<T>(method, params);
    }
    throw error;
  }
}

export async function runSession(sessionId: string): Promise<RunOutcome> {
  return await call<RunOutcome>('run', { sessionId });
}

export async function approveGate(sessionId: string, input: ApproveInput): Promise<RunOutcome> {
  return await call<RunOutcome>('approve', { sessionId, input });
}

export async function cancelSession(sessionId: string): Promise<void> {
  await call('cancel', { sessionId });
}

export async function protocolView(sessionId: string): Promise<ProtocolView> {
  return await call<ProtocolView>('view', { sessionId });
}

/** What the child may ask main to do. Nothing else crosses. */
const HANDLERS = {
  snapshot: (params: unknown): SessionSnapshot => {
    const sessionId = requireSessionId(params);
    const store = getStore();
    const session = getSession(store.db, sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);

    return {
      sessionId,
      title: session.title,
      question: session.question,
      status: session.status,
      budget: session.budget,
      roster: listParticipants(store.db, sessionId, { attachedOnly: true }),
      events: readSessionEvents(sessionId),
    };
  },

  record: (params: unknown): { recorded: number } => {
    requireSessionId(params);
    const raw = (params as { events?: unknown }).events;
    if (!Array.isArray(raw)) throw new Error('record requires an array of events');

    // Parsed here, not trusted: this is the last point before the hash chain,
    // where a malformed payload would be permanent.
    const events = raw.map((entry) => {
      const candidate = entry as { type?: unknown; payload?: unknown };
      const parsed = safeParseDomainEvent(String(candidate.type), candidate.payload);
      if (!parsed.ok) throw parsed.error;
      return { type: parsed.event.type, payload: parsed.event.payload as never };
    });

    getStore().record(events);
    return { recorded: events.length };
  },

  ask: async (params: unknown): Promise<Awaited<ReturnType<typeof runTurn>>> => {
    const sessionId = requireSessionId(params);
    const request = (params as { request?: TurnRequest }).request;
    if (!request) throw new Error('ask requires a request');

    return await runTurn({
      sessionId,
      participantId: request.participantId,
      system: request.system,
      prompt: request.prompt,
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
    });
  },

  progress: (params: unknown): void => {
    const update = params as ProgressUpdate;
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send('sheep:protocol-event', {
        sessionId: update.sessionId,
        kind: update.kind,
        detail: update.detail,
      });
    }
  },
};

/** This session's events, in chain order, already parsed against the schema. */
function readSessionEvents(sessionId: string): DomainEvent[] {
  const events: DomainEvent[] = [];
  for (const record of getStore().events.stream({ sessionId })) {
    const parsed = safeParseDomainEvent(record.type, record.payload);
    if (parsed.ok) {
      events.push(parsed.event);
      continue;
    }
    // An entry this build cannot read is skipped rather than fatal — a log
    // written by a newer version must not make the app unopenable — but it is
    // said out loud, because the protocol state it produces is now incomplete.
    logError(`the orchestrator cannot read event ${String(record.seq)} -`, parsed.error.message);
  }
  return events;
}

function requireSessionId(params: unknown): string {
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('sessionId is required');
  }
  return sessionId;
}

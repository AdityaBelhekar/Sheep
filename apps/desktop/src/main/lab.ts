import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { app, type BrowserWindow } from 'electron';
import type { IpcRequest, IpcResponse, LabEvent } from '@sheep/ipc';
import {
  DEFAULT_LIMITS,
  locateRuntime,
  lockedPackages,
  Sandbox,
  type OutputChunk,
} from '@sheep/sandbox';
import {
  getExecution,
  getSession,
  listExecutions,
  readLedger,
  recordExecution,
  recordFigures,
} from '@sheep/store';
import { logError } from './log';
import { runtimePath } from './paths';
import { getStore } from './store';
import { FRAME_MS } from './stream';

/**
 * The Lab's side of the sandbox: start a run, relay what it prints, and write
 * it down when it ends.
 *
 * A run is recorded whatever happened to it — clean, failed, timed out,
 * cancelled. The renderer is only told a run has ended once its record is in
 * the log and its artifacts are in the store, so there is no moment at which
 * the Lab shows a result that would not survive a restart.
 */

/** The most of one blob the renderer is sent. Figures are far smaller. */
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

let sandbox: Sandbox | undefined;

/** Built on first use: a missing runtime should not stop the app from opening. */
export function getSandbox(): Sandbox {
  sandbox ??= new Sandbox({
    runtime: locateRuntime(runtimePath()),
    root: join(app.getPath('userData'), 'sandbox'),
  });
  return sandbox;
}

export function labStatus(): IpcResponse<'sheep:lab-status'> {
  try {
    const { runtime } = getSandbox();
    return {
      available: true,
      detail: `CPython ${runtime.version}`,
      python: runtime.version,
      lockHash: runtime.lockHash,
      packages: lockedPackages(),
      defaults: DEFAULT_LIMITS,
    };
  } catch (error) {
    return {
      available: false,
      detail: error instanceof Error ? error.message : String(error),
      python: null,
      lockHash: null,
      packages: [],
      defaults: DEFAULT_LIMITS,
    };
  }
}

const running = new Map<string, AbortController>();

export function startLabRun(
  window: BrowserWindow,
  request: IpcRequest<'sheep:lab-run'>,
): IpcResponse<'sheep:lab-run'> {
  if (!getSession(getStore().db, request.sessionId)) {
    throw new Error(`unknown session: ${request.sessionId}`);
  }
  // Thrown here, before a run id exists, when the runtime is not installed.
  const box = getSandbox();

  const runId = randomUUID();
  const controller = new AbortController();
  running.set(runId, controller);
  void drive(box, window, runId, controller.signal, request).finally(() => {
    running.delete(runId);
  });
  return { runId };
}

export function cancelLabRun(runId: string): boolean {
  const controller = running.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function cancelAllLabRuns(): void {
  for (const controller of running.values()) controller.abort();
}

async function drive(
  box: Sandbox,
  window: BrowserWindow,
  runId: string,
  signal: AbortSignal,
  request: IpcRequest<'sheep:lab-run'>,
): Promise<void> {
  const send = (event: LabEvent): void => {
    // Nobody watching is not a reason to stop: the run is still recorded.
    if (!window.isDestroyed()) window.webContents.send('sheep:lab-event', event);
  };

  // A script printing in a loop is thousands of chunks a second. Adjacent
  // chunks on the same stream are joined and sent once a frame, in order.
  let pending: { stream: OutputChunk['stream']; data: string }[] = [];
  let timer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    clearTimeout(timer);
    timer = undefined;
    for (const chunk of pending) send({ runId, kind: 'output', ...chunk });
    pending = [];
  };
  const onOutput = (chunk: OutputChunk): void => {
    const last = pending.at(-1);
    if (last?.stream === chunk.stream) last.data += chunk.data;
    else pending.push({ ...chunk });
    timer ??= setTimeout(flush, FRAME_MS);
  };

  try {
    const result = await box.run({
      code: request.code,
      executionId: runId,
      signal,
      onOutput,
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      // Absent keys fall back to the defaults; `undefined` ones must not reach them.
      limits: Object.fromEntries(
        Object.entries(request.limits ?? {}).filter(([, value]) => value !== undefined),
      ),
    });
    flush();
    try {
      const execution = await recordExecution(getStore(), request.sessionId, request.code, result);
      // Any figure the script saved is an artifact from here on, traceable to this run.
      recordFigures(getStore(), execution);
      send({ runId, kind: 'end', execution, detail: result.detail ?? null });
    } finally {
      result.dispose();
    }
  } catch (error) {
    flush();
    logError('lab run failed -', error);
    send({
      runId,
      kind: 'error',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
    });
  }
}

/** A session's runs, and the claims that rest on each. */
export function readExecutions(sessionId: string): IpcResponse<'sheep:executions-list'> {
  const store = getStore();
  const backing = new Map<string, string[]>();
  for (const claim of readLedger(store.events, sessionId).claims()) {
    for (const evidence of claim.support) {
      if (evidence.kind !== 'EXECUTION') continue;
      backing.set(evidence.ref, [...(backing.get(evidence.ref) ?? []), claim.claimId]);
    }
  }
  const executions = listExecutions(store.db, sessionId);
  return {
    executions,
    backing: executions.flatMap(({ executionId }) => {
      const claimIds = backing.get(executionId);
      return claimIds ? [{ executionId, claimIds }] : [];
    }),
  };
}

export function readExecutionBlob(
  request: IpcRequest<'sheep:execution-blob'>,
): IpcResponse<'sheep:execution-blob'> {
  const store = getStore();
  const execution = getExecution(store.db, request.executionId);
  if (!execution) throw new Error(`unknown execution: ${request.executionId}`);

  const owned = new Set([
    execution.codeHash,
    execution.stdoutHash,
    execution.stderrHash,
    ...execution.artifacts.map((artifact) => artifact.hash),
  ]);
  if (!owned.has(request.hash)) {
    throw new Error(`execution ${request.executionId} holds no blob ${request.hash}`);
  }

  // ponytail: read whole, then sliced; stream it if artifacts ever get large.
  const bytes = store.blobs.read(request.hash);
  return {
    base64: Buffer.from(bytes.subarray(0, MAX_BLOB_BYTES)).toString('base64'),
    bytes: bytes.byteLength,
    truncated: bytes.byteLength > MAX_BLOB_BYTES,
  };
}

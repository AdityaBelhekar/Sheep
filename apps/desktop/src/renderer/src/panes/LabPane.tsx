import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { ExecutionArtifact, ExecutionLimits, ExecutionRecord } from '@sheep/core';
import type { IpcClient, IpcResponse, LabEvent } from '@sheep/ipc';
import { paneById } from '@shared/panes';
import { CodeEditor } from '../components/CodeEditor';

type Status = IpcResponse<'sheep:lab-status'>;
type History = IpcResponse<'sheep:executions-list'>;
type Segment = { stream: 'stdout' | 'stderr'; data: string };

/** The run started from this pane, while it runs and after. */
interface Live {
  runId: string;
  segments: Segment[];
  running: boolean;
  /** Set when the run could not be started or recorded at all. */
  problem: string | null;
  detail: string | null;
}

const STARTER = `# Runs in a sandbox: capped memory and CPU, a wall clock, no network.
# Files saved to the working directory are kept as hashed artifacts.
# The run is seeded, so the same script gives the same output.
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng()
walk = np.cumsum(rng.normal(size=500))
print(f"final position: {walk[-1]:.3f}")

plt.plot(walk)
plt.title("A seeded random walk")
plt.savefig("walk.png", dpi=120)
`;

/**
 * What was being written, kept across navigation. The pane unmounts when
 * another is opened, and a script half-typed should still be there on return.
 */
const draft = { code: STARTER, seed: 0 };

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

const imageTypeOf = (path: string): string | undefined =>
  IMAGE_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];

/**
 * The Lab: write a script, run it confined, and keep what it produced.
 *
 * Nothing shown here as a result is a preview. A run's output and figures
 * appear once the run has been recorded — code, streams and artifacts in the
 * content-addressed store, one event in the log — so every result on this pane
 * has an execution id a claim can point at.
 */
export function LabPane({
  client,
  onStoreChanged,
}: {
  client: IpcClient | undefined;
  onStoreChanged: () => void;
}): ReactElement {
  const pane = paneById('lab');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [code, setCode] = useState(draft.code);
  const [seed, setSeed] = useState(draft.seed);
  const [limits, setLimits] = useState<ExecutionLimits | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  draft.code = code;
  draft.seed = seed;

  useEffect(() => {
    if (!client) return;
    const signal = { cancelled: false };
    // The open session is the shell's, written by the roster panel.
    client
      .invoke('sheep:settings-read', {})
      .then((reply) => {
        if (!signal.cancelled) setSessionId(reply.settings['ui.lastSessionId']);
      })
      .catch(() => {
        // No session preselected; the empty state says what to do.
      });
    client
      .invoke('sheep:lab-status', {})
      .then((reply) => {
        if (signal.cancelled) return;
        setStatus(reply);
        setLimits(reply.defaults);
      })
      .catch((error: unknown) => {
        if (!signal.cancelled) setProblem(describe(error));
      });
    return () => {
      signal.cancelled = true;
    };
  }, [client]);

  const loadHistory = useCallback(async () => {
    if (!client || sessionId === null) return;
    try {
      setHistory(await client.invoke('sheep:executions-list', { sessionId }));
    } catch (error) {
      setProblem(describe(error));
    }
  }, [client, sessionId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // Events are matched to the run this pane started; anything else on the
  // channel belongs to a run nobody here is watching.
  const liveRunId = useRef<string | null>(null);
  liveRunId.current = live?.runId ?? null;

  useEffect(() => {
    if (!client) return;
    return client.on('sheep:lab-event', (event: LabEvent) => {
      if (event.runId !== liveRunId.current) return;
      if (event.kind === 'output') {
        setLive((current) => current && { ...current, segments: append(current.segments, event) });
        return;
      }
      if (event.kind === 'end') {
        setLive((current) => current && { ...current, running: false, detail: event.detail });
        setSelected(event.execution.executionId);
        void loadHistory();
        onStoreChanged();
        return;
      }
      setLive((current) => current && { ...current, running: false, problem: event.message });
    });
  }, [client, loadHistory, onStoreChanged]);

  const running = live?.running ?? false;
  const canRun = Boolean(client && sessionId !== null && status?.available && limits && !running);

  const run = (): void => {
    if (!client || sessionId === null || !limits || !canRun) return;
    setProblem(null);
    client
      .invoke('sheep:lab-run', { sessionId, code, seed, limits })
      .then(({ runId }) => {
        setSelected(null);
        setLive({ runId, segments: [], running: true, problem: null, detail: null });
      })
      .catch((error: unknown) => {
        setProblem(describe(error));
      });
  };

  const cancel = (): void => {
    if (!client || !live?.running) return;
    void client.invoke('sheep:lab-cancel', { runId: live.runId }).catch(() => {
      // Too late to cancel is not worth reporting; the run's own end will arrive.
    });
  };

  const shown = history?.executions.find((execution) => execution.executionId === selected);
  const backing = (executionId: string): readonly string[] =>
    history?.backing.find((entry) => entry.executionId === executionId)?.claimIds ?? [];

  return (
    <section
      className="pane pane--wide"
      data-pane="lab"
      data-sheep-lab={status ? (status.available ? 'ready' : 'unavailable') : 'pending'}
      data-sheep-runs={history ? String(history.executions.length) : undefined}
    >
      <header className="pane__header">
        <h1 className="pane__title">{pane.label}</h1>
        <p className="pane__summary">{pane.summary}</p>
      </header>

      {!client && <p className="notice notice--error">The Lab needs the preload bridge.</p>}

      {status && !status.available && (
        <p className="notice notice--error" role="alert">
          The sandbox cannot run: {status.detail}
        </p>
      )}

      {client && sessionId === null && (
        <div className="empty">
          <p className="empty__title">No session is open</p>
          <p className="empty__body">Open a session first.</p>
        </div>
      )}

      {client && sessionId !== null && (
        <div className="lab">
          <div className="lab__compose">
            <CodeEditor value={code} onChange={setCode} onRun={run} />

            <div className="lab__controls">
              <NumberField label="Seed" value={seed} min={0} max={4294967295} onChange={setSeed} />
              {limits && (
                <>
                  <NumberField
                    label="Memory MB"
                    value={limits.memoryMb}
                    min={64}
                    max={65536}
                    onChange={(memoryMb) => {
                      setLimits({ ...limits, memoryMb });
                    }}
                  />
                  <NumberField
                    label="CPU %"
                    value={limits.cpuPercent}
                    min={1}
                    max={100}
                    onChange={(cpuPercent) => {
                      setLimits({ ...limits, cpuPercent });
                    }}
                  />
                  <NumberField
                    label="Timeout s"
                    value={Math.round(limits.timeoutMs / 1000)}
                    min={1}
                    max={3600}
                    onChange={(seconds) => {
                      setLimits({ ...limits, timeoutMs: seconds * 1000 });
                    }}
                  />
                </>
              )}
              <span className="lab__spacer" />
              {running ? (
                <button type="button" className="button button--danger" onClick={cancel}>
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="button"
                  data-sheep-lab-run
                  disabled={!canRun}
                  title="Ctrl+Enter"
                  onClick={run}
                >
                  Run
                </button>
              )}
            </div>

            {status?.available && (
              <p className="lab__runtime">
                CPython {status.python} · {status.packages.length} locked packages · env{' '}
                <code>{status.lockHash?.slice(0, 12)}</code> · no network
              </p>
            )}
            {problem !== null && (
              <p className="notice notice--error" role="alert">
                {problem}
              </p>
            )}
          </div>

          <div className="lab__result">
            {live && (live.running || live.problem !== null) && (
              <div className="lab__run" data-sheep-lab-live>
                <div className="lab__run-head">
                  <span className="badge" data-status={live.running ? 'running' : 'failed'}>
                    {live.running ? 'running' : 'not recorded'}
                  </span>
                </div>
                {live.problem !== null && (
                  <p className="notice notice--error" role="alert">
                    {live.problem}
                  </p>
                )}
                <Output segments={live.segments} />
              </div>
            )}

            {shown && !running && (
              <RunView
                key={shown.executionId}
                client={client}
                execution={shown}
                claimIds={backing(shown.executionId)}
                // The run just finished keeps the order its output arrived in;
                // a run from history has only the two streams as stored.
                segments={live?.runId === shown.executionId ? live.segments : null}
                detail={live?.runId === shown.executionId ? live.detail : null}
                onLoadCode={setCode}
              />
            )}

            {!shown && !live && (
              <div className="empty">
                <p className="empty__title">Nothing run yet</p>
                <p className="empty__body">
                  Run the script, or pick an earlier run below. Output and figures appear here once
                  the run has been recorded.
                </p>
              </div>
            )}
          </div>

          {history && history.executions.length > 0 && (
            <div className="lab__history">
              <h2 className="calibration__title">Runs in this session</h2>
              <ul className="lab__runs">
                {history.executions.map((execution) => (
                  <li key={execution.executionId}>
                    <button
                      type="button"
                      className="lab__run-row"
                      data-sheep-run={execution.executionId}
                      aria-current={execution.executionId === selected ? 'true' : undefined}
                      onClick={() => {
                        setSelected(execution.executionId);
                      }}
                    >
                      <span className="badge" data-status={badgeStatus(execution)}>
                        {execution.status}
                      </span>
                      <span>{new Date(execution.recordedAt).toLocaleString()}</span>
                      <span className="lab__muted">{formatDuration(execution.durationMs)}</span>
                      <span className="lab__muted">
                        {execution.artifacts.length} artifact
                        {execution.artifacts.length === 1 ? '' : 's'}
                      </span>
                      {backing(execution.executionId).length > 0 && (
                        <span className="lab__muted">
                          backs {backing(execution.executionId).length} claim
                          {backing(execution.executionId).length === 1 ? '' : 's'}
                        </span>
                      )}
                      <code className="lab__muted">{execution.executionId.slice(0, 8)}</code>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** One recorded run: what it was, what it printed, what it left behind. */
function RunView({
  client,
  execution,
  claimIds,
  segments,
  detail,
  onLoadCode,
}: {
  client: IpcClient;
  execution: ExecutionRecord;
  claimIds: readonly string[];
  segments: Segment[] | null;
  detail: string | null;
  onLoadCode: (code: string) => void;
}): ReactElement {
  const [stored, setStored] = useState<Segment[] | null>(segments);
  const [problem, setProblem] = useState<string | null>(null);
  const { executionId } = execution;

  useEffect(() => {
    if (segments !== null) return;
    const signal = { cancelled: false };
    Promise.all([
      readText(client, executionId, execution.stdoutHash),
      readText(client, executionId, execution.stderrHash),
    ])
      .then(([stdout, stderr]) => {
        if (signal.cancelled) return;
        setStored(
          [
            { stream: 'stdout' as const, data: stdout },
            { stream: 'stderr' as const, data: stderr },
          ].filter((segment) => segment.data !== ''),
        );
      })
      .catch((error: unknown) => {
        if (!signal.cancelled) setProblem(describe(error));
      });
    return () => {
      signal.cancelled = true;
    };
  }, [client, executionId, execution.stdoutHash, execution.stderrHash, segments]);

  return (
    <div className="lab__run" data-sheep-lab-result={execution.status}>
      <div className="lab__run-head">
        <span className="badge" data-status={badgeStatus(execution)}>
          {execution.status}
        </span>
        <span className="lab__spacer" />
        <button
          type="button"
          className="button button--quiet"
          onClick={() => {
            readText(client, executionId, execution.codeHash)
              .then(onLoadCode)
              .catch((error: unknown) => {
                setProblem(describe(error));
              });
          }}
        >
          Load this code
        </button>
      </div>

      <dl className="drawer__facts">
        <dt>Execution</dt>
        <dd>
          <code className="drawer__mono" data-sheep-execution-id>
            {executionId}
          </code>
        </dd>
        <dt>Exit</dt>
        <dd>
          {execution.exitCode === -1 ? 'stopped' : `code ${String(execution.exitCode)}`} ·{' '}
          {formatDuration(execution.durationMs)}
          {execution.peakMemoryBytes !== null &&
            ` · peak ${formatBytes(execution.peakMemoryBytes)}`}
        </dd>
        <dt>Held to</dt>
        <dd>
          {execution.limits.memoryMb} MB · {execution.limits.cpuPercent}% CPU ·{' '}
          {formatDuration(execution.limits.timeoutMs)}
        </dd>
        <dt>Reproduce</dt>
        <dd>
          seed {execution.seed} · env <code>{execution.envLockHash.slice(0, 12)}</code> · code{' '}
          <code>{execution.codeHash.slice(0, 12)}</code>
        </dd>
        <dt>Claims</dt>
        <dd>
          {claimIds.length === 0
            ? execution.status === 'ok'
              ? 'none yet — cite the execution id as EXECUTION evidence in the Ledger'
              : 'none — a run that did not exit cleanly cannot back a claim'
            : claimIds.map((claimId) => claimId.slice(0, 8)).join(', ')}
        </dd>
      </dl>

      {detail !== null && <p className="notice notice--error">{detail}</p>}
      {problem !== null && (
        <p className="notice notice--error" role="alert">
          {problem}
        </p>
      )}

      {stored && <Output segments={stored} />}
      {execution.truncated && (
        <p className="lab__muted">Output past 4 MB was dropped before it was stored.</p>
      )}

      {execution.artifacts.length > 0 && (
        <div className="lab__artifacts">
          {execution.artifacts.map((artifact) => (
            <Artifact
              key={artifact.path}
              client={client}
              executionId={executionId}
              artifact={artifact}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Output({ segments }: { segments: Segment[] }): ReactElement {
  const end = useRef<HTMLSpanElement>(null);
  // Follow the output as it grows, the way a terminal does.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [segments]);

  return (
    <pre className="lab__output" data-sheep-lab-output>
      {segments.length === 0 && <span className="lab__muted">no output</span>}
      {segments.map((segment, index) => (
        <span key={index} data-stream={segment.stream}>
          {segment.data}
        </span>
      ))}
      <span ref={end} />
    </pre>
  );
}

/** A file a run left behind. Images are shown; everything else is listed. */
function Artifact({
  client,
  executionId,
  artifact,
}: {
  client: IpcClient;
  executionId: string;
  artifact: ExecutionArtifact;
}): ReactElement {
  const mediaType = imageTypeOf(artifact.path);
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    if (mediaType === undefined) return;
    const signal = { cancelled: false };
    client
      .invoke('sheep:execution-blob', { executionId, hash: artifact.hash })
      .then((blob) => {
        // An <img> does not run scripts, so an SVG a script wrote is inert here.
        if (!signal.cancelled) setSource(`data:${mediaType};base64,${blob.base64}`);
      })
      .catch(() => {
        // The caption below still names the artifact and its hash.
      });
    return () => {
      signal.cancelled = true;
    };
  }, [client, executionId, artifact.hash, mediaType]);

  return (
    <figure className="lab__artifact">
      {source !== null && (
        <img className="lab__plot" src={source} alt={artifact.path} data-sheep-plot />
      )}
      <figcaption>
        <span>{artifact.path}</span>
        <span className="lab__muted">{formatBytes(artifact.bytes)}</span>
        <code className="lab__muted" title={artifact.hash}>
          {artifact.hash.slice(0, 12)}
        </code>
      </figcaption>
    </figure>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}): ReactElement {
  return (
    <label className="field field--inline">
      <span className="field__label">{label}</span>
      <input
        className="field__input field__input--narrow"
        type="number"
        value={value}
        min={min}
        max={max}
        step={1}
        onChange={(event) => {
          const next = Math.round(event.target.valueAsNumber);
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
        }}
      />
    </label>
  );
}

/** Joins a chunk onto the last segment when it is the same stream. */
function append(segments: Segment[], chunk: Segment): Segment[] {
  const last = segments.at(-1);
  if (last?.stream !== chunk.stream) {
    return [...segments, { stream: chunk.stream, data: chunk.data }];
  }
  return [...segments.slice(0, -1), { stream: last.stream, data: last.data + chunk.data }];
}

async function readText(client: IpcClient, executionId: string, hash: string): Promise<string> {
  const blob = await client.invoke('sheep:execution-blob', { executionId, hash });
  const bytes = Uint8Array.from(atob(blob.base64), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The existing badge colours: green for a clean exit, red for anything else. */
function badgeStatus(execution: ExecutionRecord): string {
  return execution.status === 'ok' ? 'ok' : 'failed';
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${String(ms)} ms` : `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 0)} s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // The reason is the useful part; the IPC wrapping is not.
  return message.replace(/^.*IPC_HANDLER_FAILED: [^ ]+ /, '');
}

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { GateKind } from '@sheep/core';
import type { IpcClient, IpcResponse, ProtocolEvent } from '@sheep/ipc';

type Reply = IpcResponse<'sheep:protocol-state'>;
type PhaseView = Reply['state']['phases'][number];

/**
 * The protocol, and the two places it stops to ask.
 *
 * Deliberately small. The orchestrator's output is the conversation below it —
 * this strip exists to answer three questions the turns alone cannot: where the
 * session is, whether anything is waiting on the person reading it, and what
 * the charter or the hypotheses actually say.
 *
 * The gate is the reason it is not just a status line. A charter nobody
 * approved is not a charter, and hypotheses nobody chose are not a research
 * programme; the buttons here are the only way either becomes real.
 */
export function ProtocolPanel({
  client,
  sessionId,
  onStoreChanged,
}: {
  client: IpcClient | undefined;
  sessionId: string;
  onStoreChanged: () => void;
}): ReactElement {
  const [reply, setReply] = useState<Reply | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [activity, setActivity] = useState<string | null>(null);

  const read = useCallback(async () => {
    if (!client) return;
    try {
      setReply(await client.invoke('sheep:protocol-state', { sessionId }));
    } catch (error) {
      setProblem(describe(error));
    }
  }, [client, sessionId]);

  useEffect(() => {
    void read();
  }, [read]);

  // Progress is advisory: it says something moved, and the state is then re-read
  // from the log rather than patched from the notice.
  useEffect(() => {
    if (!client) return;
    return client.on('sheep:protocol-event', (event: ProtocolEvent) => {
      if (event.sessionId !== sessionId) return;
      setActivity(event.detail);
      if (event.kind === 'gate-raised' || event.kind === 'phase-closed') {
        void read();
        onStoreChanged();
      }
    });
  }, [client, onStoreChanged, read, sessionId]);

  const drive = useCallback(
    async (action: () => Promise<Reply>) => {
      if (!client || busy) return;
      setBusy(true);
      setProblem(null);
      try {
        setReply(await action());
        setChosen([]);
        setNote('');
      } catch (error) {
        setProblem(describe(error));
      } finally {
        setBusy(false);
        setActivity(null);
        onStoreChanged();
      }
    },
    [busy, client, onStoreChanged],
  );

  if (!client) return <p className="notice">The protocol needs the preload bridge.</p>;

  const phases = reply?.state.phases ?? [];
  const open = phases.find(
    (phase) => phase.status === 'running' || phase.status === 'awaiting-approval',
  );
  const gate = open?.gate && open.gate.decision === null ? open.gate : null;
  const running = reply?.state.status === 'running';

  return (
    <section className="protocol" data-sheep-protocol={reply?.status ?? 'unknown'}>
      <div className="protocol__head">
        <ol className="protocol__phases">
          {PHASE_ORDER.map((kind) => {
            const phase = phases.find((candidate) => candidate.kind === kind);
            return (
              <li
                key={kind}
                className="protocol__phase"
                data-status={phase?.status ?? 'pending'}
                title={describePhase(kind, phase)}
              >
                {kind.slice(0, 4)}
              </li>
            );
          })}
        </ol>

        <span className="protocol__spacer" />

        {activity !== null && <span className="protocol__activity">{activity}</span>}

        <button
          type="button"
          className="button"
          data-sheep-protocol-run
          disabled={busy || gate !== null}
          onClick={() => {
            void drive(() => client.invoke('sheep:protocol-run', { sessionId }));
          }}
        >
          {busy ? 'Running…' : phases.length === 0 ? 'Start the protocol' : 'Continue'}
        </button>
        {busy && running && (
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              void client.invoke('sheep:protocol-cancel', { sessionId }).catch(() => {
                // The run stops at the next step either way; a failed request
                // here is not worth interrupting for.
              });
            }}
          >
            Stop
          </button>
        )}
      </div>

      {reply && reply.status !== 'idle' && (
        <p className="protocol__detail" data-status={reply.status}>
          {reply.detail}
        </p>
      )}

      {problem !== null && (
        <p className="notice notice--error" role="alert">
          {problem}
        </p>
      )}

      {gate && open && (
        <div className="gate" data-sheep-gate={gate.gate}>
          <h3 className="gate__title">
            {gate.gate === 'charter' ? 'Charter — your approval' : 'Hypotheses — your selection'}
          </h3>

          {gate.options.length === 0 ? (
            <pre className="gate__proposal">{gate.proposal}</pre>
          ) : (
            <>
              <p className="gate__summary">{gate.proposal}</p>
              <ul className="gate__options">
                {gate.options.map((option) => (
                  <li key={option.optionId} className="gate__option">
                    <label>
                      <input
                        type="checkbox"
                        checked={chosen.includes(option.optionId)}
                        onChange={(event) => {
                          setChosen((current) =>
                            event.target.checked
                              ? [...current, option.optionId]
                              : current.filter((id) => id !== option.optionId),
                          );
                        }}
                      />
                      <span className="gate__label">{option.label}</span>
                      {option.score !== undefined && (
                        <span className="badge">{option.score.toFixed(2)}</span>
                      )}
                    </label>
                    {option.detail !== undefined && <p className="gate__detail">{option.detail}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}

          <label className="gate__note">
            <span>Note (sent back to the referee if you send this for revision)</span>
            <textarea
              rows={2}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </label>

          <div className="gate__actions">
            <button
              type="button"
              className="button"
              data-sheep-gate-approve
              disabled={busy || (gate.options.length > 0 && chosen.length === 0)}
              onClick={() => {
                void drive(() =>
                  client.invoke('sheep:protocol-approve', {
                    sessionId,
                    gate: gate.gate as GateKind,
                    decision: 'approved',
                    ...(chosen.length === 0 ? {} : { selected: [...chosen] }),
                    ...(note.trim() === '' ? {} : { note: note.trim() }),
                  }),
                );
              }}
            >
              Approve
            </button>
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              onClick={() => {
                void drive(() =>
                  client.invoke('sheep:protocol-approve', {
                    sessionId,
                    gate: gate.gate as GateKind,
                    decision: 'rejected',
                    ...(note.trim() === '' ? {} : { note: note.trim() }),
                  }),
                );
              }}
            >
              Send back for revision
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const PHASE_ORDER = [
  'FRAMING',
  'HYPOTHESIS',
  'METHOD',
  'EXECUTION',
  'CRITIQUE',
  'RESOLUTION',
  'SYNTHESIS',
] as const;

function describePhase(kind: string, phase: PhaseView | undefined): string {
  if (!phase) return `${kind} — not started`;
  const rounds = `${String(phase.rounds.length)} round${phase.rounds.length === 1 ? '' : 's'}`;
  return `${kind} — ${phase.status}, ${rounds}${phase.summary === null ? '' : `: ${phase.summary}`}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

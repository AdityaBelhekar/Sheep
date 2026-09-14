import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { Message, RosterEntry, SessionSummary } from '@sheep/core';
import type { IpcClient, StreamEvent } from '@sheep/ipc';
import { paneById } from '@shared/panes';
import { ProtocolPanel } from './ProtocolPanel';

/** A run in flight: what has arrived so far, and what it turned into. */
interface LiveRun {
  readonly runId: string;
  readonly messageId: string;
  readonly participantId: string;
  text: string;
  reasoning: string;
  error: string | null;
}

type Loaded =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ready';
      session: SessionSummary;
      roster: readonly RosterEntry[];
      messages: readonly Message[];
    }
  | { kind: 'error'; message: string };

/**
 * A plain streaming chat against one attached model.
 *
 * Not a product feature — it is the proof that the whole pipe works: a
 * connection, a roster entry, the gateway, the delta protocol, the event log,
 * the projection, and a one-way channel back to React. Everything Stage 4 runs
 * many of, this runs one of.
 */
export function ConversationPane({
  client,
  onStoreChanged,
}: {
  client: IpcClient | undefined;
  onStoreChanged: () => void;
}): ReactElement {
  const pane = paneById('conversation');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<Loaded>({ kind: 'idle' });
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<LiveRun | null>(null);
  const [stopping, setStopping] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  // Which session is open is the shell's business, not this pane's: the roster
  // panel writes it, and this reads the same setting rather than keeping a
  // second answer that could disagree.
  useEffect(() => {
    if (!client) return;
    const signal = { cancelled: false };
    client
      .invoke('sheep:settings-read', {})
      .then((reply) => {
        if (!signal.cancelled) setSessionId(reply.settings['ui.lastSessionId']);
      })
      .catch(() => {
        // Nothing preselected is a legitimate state; the empty state explains it.
      });
    return () => {
      signal.cancelled = true;
    };
  }, [client]);

  const load = useCallback(
    async (signal?: { cancelled: boolean }) => {
      if (!client || sessionId === null) {
        setState({ kind: 'idle' });
        return;
      }
      try {
        const [detail, history] = await Promise.all([
          client.invoke('sheep:session-get', { sessionId }),
          client.invoke('sheep:messages-list', { sessionId }),
        ]);
        if (signal?.cancelled) return;
        setState({
          kind: 'ready',
          session: detail.session,
          roster: detail.roster.filter((entry) => entry.detachedAt === null),
          messages: history.messages,
        });
      } catch (error) {
        if (!signal?.cancelled) setState({ kind: 'error', message: describe(error) });
      }
    },
    [client, sessionId],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    if (sessionId !== null) setState({ kind: 'loading' });
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load, sessionId]);

  /**
   * The stream.
   *
   * Subscribed once for the pane's lifetime rather than per run: six concurrent
   * runs share one channel, and a listener per run would mean six listeners
   * each filtering out five sixths of what they were handed.
   */
  useEffect(() => {
    if (!client) return;
    return client.on(
      'sheep:stream-event',
      (event: StreamEvent) => {
        setLive((current) => {
          if (event.kind === 'start') {
            return {
              runId: event.runId,
              messageId: event.messageId,
              participantId: event.participantId,
              text: '',
              reasoning: '',
              error: null,
            };
          }
          if (!current || current.runId !== event.runId) return current;

          switch (event.kind) {
            case 'text':
              return { ...current, text: current.text + event.text };
            case 'reasoning':
              return { ...current, reasoning: current.reasoning + event.text };
            case 'error':
              return { ...current, error: event.message };
            case 'end':
              // The message is in the log now; re-reading the projection is
              // what makes it real on screen, so the live copy goes away.
              return null;
            default:
              return current;
          }
        });

        if (event.kind === 'end') {
          setStopping(false);
          void load();
          onStoreChanged();
        }
      },
      {
        onInvalid: (issues) => {
          setProblem(`a stream event failed its contract: ${issues.join('; ')}`);
        },
      },
    );
  }, [client, load, onStoreChanged]);

  const roster = state.kind === 'ready' ? state.roster : [];
  const chosen = useMemo(
    () => roster.find((entry) => entry.participantId === participantId) ?? roster[0],
    [roster, participantId],
  );

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [state, live]);

  const send = (): void => {
    if (!client || !chosen || sessionId === null || draft.trim() === '') return;
    const text = draft.trim();
    setProblem(null);
    setDraft('');

    client
      .invoke('sheep:chat-send', {
        sessionId,
        participantId: chosen.participantId,
        text,
      })
      .then(() => {
        void load();
        onStoreChanged();
      })
      .catch((error: unknown) => {
        setProblem(describe(error));
        // The message never left, so give it back rather than losing what was typed.
        setDraft(text);
      });
  };

  const cancel = (): void => {
    if (!client || !live || stopping) return;
    setStopping(true);
    void client
      .invoke('sheep:chat-cancel', { runId: live.runId })
      .catch((error: unknown) => {
        setProblem(describe(error));
      })
      .finally(() => {
        // The button stays disabled until the run's `end` clears `live`: a
        // second press would cancel nothing and only look like it failed.
        setStopping(false);
      });
  };

  return (
    <section
      className="pane"
      data-pane="conversation"
      data-sheep-conversation={state.kind}
      data-sheep-messages={state.kind === 'ready' ? String(state.messages.length) : ''}
      data-sheep-streaming={live === null ? 'idle' : 'streaming'}
    >
      <header className="pane__header">
        <h1 className="pane__title">{pane.label}</h1>
        <p className="pane__summary">{pane.summary}</p>
      </header>

      {state.kind === 'idle' && (
        <div className="empty">
          <p className="empty__title">No session open</p>
          <p className="empty__body">
            Open a session from Sessions and attach a model to its roster. This surface talks to one
            model at a time — the blind-parallel rounds that make a critique independent arrive with
            the orchestrator in Stage 4.
          </p>
        </div>
      )}

      {state.kind === 'loading' && <p className="notice">Reading the session…</p>}

      {state.kind === 'error' && (
        <p className="notice notice--error" role="alert">
          {state.message}
        </p>
      )}

      {state.kind === 'ready' && (
        <>
          <div className="chat__head">
            <div>
              <h2 className="roster__title">{state.session.title}</h2>
              <p className="roster__question">{state.session.question}</p>
            </div>
            <span className="roster__spent">
              {formatUsd(state.session.budget.spentUsd)} spent
              {state.session.budget.capUsd === null
                ? ''
                : ` of ${formatUsd(state.session.budget.capUsd)}`}
            </span>
          </div>

          <ProtocolPanel
            client={client}
            sessionId={state.session.sessionId}
            onStoreChanged={() => {
              void load();
              onStoreChanged();
            }}
          />

          {roster.length === 0 ? (
            <div className="empty">
              <p className="empty__title">No models attached</p>
              <p className="empty__body">
                Attach at least one model to this session&rsquo;s roster before asking it anything.
              </p>
            </div>
          ) : (
            <>
              <ol className="chat">
                {state.messages.map((message) => (
                  <li
                    className="chat__turn"
                    key={message.messageId}
                    data-author={message.author.kind}
                  >
                    <div className="chat__meta">
                      <span className="chat__who">
                        {message.author.kind === 'MODEL'
                          ? message.author.model.modelId
                          : message.author.kind === 'HUMAN'
                            ? 'You'
                            : 'Sheep'}
                      </span>
                      {message.author.kind === 'MODEL' && (
                        <span className="badge">{message.author.model.vendorId}</span>
                      )}
                      {message.finish !== null && message.finish !== 'stop' && (
                        <span className="badge" data-status={finishStatus(message.finish)}>
                          {message.finish}
                        </span>
                      )}
                      {message.usage !== null && (
                        <span className="chat__usage">
                          {message.usage.inputTokens} in / {message.usage.outputTokens} out ·{' '}
                          {formatUsd(message.usage.costUsd)}
                        </span>
                      )}
                    </div>
                    <p className="chat__body">
                      {message.body.kind !== 'text' ? (
                        '(stored as a blob)'
                      ) : message.body.text === '' ? (
                        <span className="chat__empty">
                          {message.finish === 'cancelled'
                            ? 'stopped before the model said anything'
                            : 'no text'}
                        </span>
                      ) : (
                        message.body.text
                      )}
                    </p>
                  </li>
                ))}

                {live !== null && (
                  <li className="chat__turn chat__turn--live" data-author="MODEL">
                    <div className="chat__meta">
                      <span className="chat__who">
                        {roster.find((entry) => entry.participantId === live.participantId)?.model
                          .modelId ?? 'model'}
                      </span>
                      <span className="badge" data-status="running">
                        streaming
                      </span>
                    </div>
                    {live.reasoning !== '' && <p className="chat__reasoning">{live.reasoning}</p>}
                    <p className="chat__body">{live.text}</p>
                    {live.error !== null && (
                      <p className="notice notice--error" role="alert">
                        {live.error}
                      </p>
                    )}
                  </li>
                )}
                <div ref={bottom} />
              </ol>

              {problem !== null && (
                <p className="notice notice--error" role="alert">
                  {problem}
                </p>
              )}

              <form
                className="chat__composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  send();
                }}
              >
                <div className="field field--inline">
                  <label className="field__label" htmlFor="chat-participant">
                    Model
                  </label>
                  <select
                    id="chat-participant"
                    className="field__input"
                    value={chosen?.participantId ?? ''}
                    onChange={(event) => {
                      setParticipantId(event.target.value);
                    }}
                  >
                    {roster.map((entry) => (
                      <option key={entry.participantId} value={entry.participantId}>
                        {entry.model.modelId} ({entry.model.vendorId})
                      </option>
                    ))}
                  </select>
                </div>

                <textarea
                  className="field__input field__input--multiline"
                  rows={3}
                  placeholder="Ask this model something…"
                  value={draft}
                  disabled={live !== null}
                  onChange={(event) => {
                    setDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    // Enter sends, Shift+Enter breaks the line — the convention
                    // every chat surface has trained people to expect.
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      send();
                    }
                  }}
                />

                <div className="button-row">
                  <button
                    className="button"
                    type="submit"
                    data-sheep-send="true"
                    disabled={live !== null || draft.trim() === '' || !chosen}
                  >
                    Send
                  </button>
                  {live !== null && (
                    <button
                      className="button button--danger"
                      type="button"
                      data-sheep-cancel="true"
                      disabled={stopping}
                      onClick={cancel}
                    >
                      {stopping ? 'Stopping…' : 'Stop'}
                    </button>
                  )}
                </div>
              </form>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** Anything but a clean stop is worth colouring; cancelled is not a failure. */
function finishStatus(finish: NonNullable<Message['finish']>): string {
  return finish === 'error' ? 'failed' : 'unknown';
}

function formatUsd(amount: number): string {
  return amount >= 0.01 || amount === 0 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

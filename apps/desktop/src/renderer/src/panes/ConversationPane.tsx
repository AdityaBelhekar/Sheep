import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { Message, ModelRef, RosterEntry, SessionSummary } from '@sheep/core';
import type { IpcClient, StreamEvent } from '@sheep/ipc';
import { paneById } from '@shared/panes';
import { EarTag, tagIndex } from '../components/EarTag';
import type { PhaseView } from '../components/PhaseTrack';
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
      /** Everyone ever attached: a detached model's turns still need its tag. */
      everyone: readonly RosterEntry[];
      roster: readonly RosterEntry[];
      messages: readonly Message[];
      phases: readonly PhaseView[];
    }
  | { kind: 'error'; message: string };

/**
 * The protocol's turns, and a way to ask one model something on the side.
 *
 * Drawn as lanes rather than a chat list: a round is a row and a model is a
 * column, so answers committed blind sit side by side, as they were written.
 * A turn outside any round — an aside from the composer — is drawn on its own.
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
        const [detail, history, protocol] = await Promise.all([
          client.invoke('sheep:session-get', { sessionId }),
          client.invoke('sheep:messages-list', { sessionId }),
          // Rounds only label the turns; without them the turns are still shown.
          client.invoke('sheep:protocol-state', { sessionId }).catch(() => null),
        ]);
        if (signal?.cancelled) return;
        setState({
          kind: 'ready',
          session: detail.session,
          everyone: detail.roster,
          phases: protocol?.state.phases ?? [],
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

  const everyone = state.kind === 'ready' ? state.everyone : [];
  const blocks = useMemo(() => (state.kind === 'ready' ? intoBlocks(state.messages) : []), [state]);
  const rounds = useMemo(
    () => (state.kind === 'ready' ? roundIndex(state.phases) : new Map<string, RoundInfo>()),
    [state],
  );
  const liveModel =
    live === null
      ? undefined
      : everyone.find((entry) => entry.participantId === live.participantId)?.model;

  return (
    <section
      className="pane pane--wide"
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
          <p className="empty__body">Open a session and attach models from at least two vendors.</p>
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
                {blocks.map((block) =>
                  block.kind === 'round' ? (
                    <RoundBlock
                      key={block.roundId}
                      messages={block.messages}
                      info={rounds.get(block.roundId)}
                      everyone={everyone}
                    />
                  ) : (
                    <li
                      className="chat__item"
                      key={block.message.messageId}
                      data-author={block.message.author.kind}
                    >
                      <Turn message={block.message} everyone={everyone} />
                    </li>
                  ),
                )}

                {live !== null && (
                  <li className="chat__item" data-author="MODEL">
                    <div className="chat__turn chat__turn--live" data-author="MODEL">
                      <div className="chat__meta">
                        {liveModel ? (
                          <EarTag
                            model={liveModel}
                            index={tagIndex(everyone, live.participantId)}
                          />
                        ) : (
                          <span className="chat__who">model</span>
                        )}
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
                    </div>
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
                <div className="chat__composer-head">
                  <div className="field field--inline">
                    <label className="field__label" htmlFor="chat-participant">
                      Ask one model, on the side
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
                  <p className="chat__composer-note">
                    An aside is recorded, but it is outside the protocol: no round, no critique, and
                    nothing it says becomes a claim.
                  </p>
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

type Block =
  { kind: 'round'; roundId: string; messages: Message[] } | { kind: 'turn'; message: Message };

/** Consecutive turns of one round become one block; everything else stands alone. */
function intoBlocks(messages: readonly Message[]): Block[] {
  const blocks: Block[] = [];
  for (const message of messages) {
    const last = blocks.at(-1);
    if (message.roundId === null) blocks.push({ kind: 'turn', message });
    else if (last?.kind === 'round' && last.roundId === message.roundId)
      last.messages.push(message);
    else blocks.push({ kind: 'round', roundId: message.roundId, messages: [message] });
  }
  return blocks;
}

type RoundInfo = PhaseView['rounds'][number] & { readonly phase: string };

function roundIndex(phases: readonly PhaseView[]): Map<string, RoundInfo> {
  const index = new Map<string, RoundInfo>();
  for (const phase of phases) {
    for (const round of phase.rounds) index.set(round.roundId, { ...round, phase: phase.kind });
  }
  return index;
}

const MODE_LABELS: Record<RoundInfo['mode'], string> = {
  BLIND_PARALLEL: 'blind — sealed from each other',
  SEQUENTIAL: 'sequential — each reads the last',
  COLLECTIVE: 'collective — one shared thread',
};

/**
 * One round: a lane per model that was in it.
 *
 * The lanes come from the round's assignments as well as from who has spoken,
 * so a model that has not answered yet still has its lane, and says it is
 * still writing rather than looking absent.
 */
function RoundBlock({
  messages,
  info,
  everyone,
}: {
  messages: readonly Message[];
  info: RoundInfo | undefined;
  everyone: readonly RosterEntry[];
}): ReactElement {
  const models = new Map<string, ModelRef>();
  for (const assignment of info?.assignments ?? []) {
    const entry = everyone.find(
      (candidate) => candidate.participantId === assignment.participantId,
    );
    if (entry) models.set(entry.participantId, entry.model);
  }
  for (const message of messages) {
    if (message.author.kind === 'MODEL') {
      models.set(message.author.participantId, message.author.model);
    }
  }
  const position = (id: string): number =>
    everyone.findIndex((entry) => entry.participantId === id);
  const lanes = [...models.entries()].sort(([a], [b]) => position(a) - position(b));
  const notes = messages.filter((message) => message.author.kind !== 'MODEL');

  return (
    <li className="round" data-sheep-round={info?.mode ?? 'unknown'}>
      <div className="round__head">
        <span className="round__phase">{info?.phase.toLowerCase() ?? 'round'}</span>
        {info && <span>round {info.index + 1}</span>}
        {info && <span className="round__mode">{MODE_LABELS[info.mode]}</span>}
        <span className="round__spacer" />
        {info && info.status !== 'complete' && (
          <span className="badge" data-status={info.status === 'open' ? 'running' : 'failed'}>
            {info.status}
          </span>
        )}
      </div>

      <div className="round__lanes" style={{ ['--lanes' as string]: Math.max(1, lanes.length) }}>
        {lanes.map(([participantId, model]) => {
          const turns = messages.filter(
            (message) =>
              message.author.kind === 'MODEL' && message.author.participantId === participantId,
          );
          const role =
            info?.assignments.find((assignment) => assignment.participantId === participantId)
              ?.role ?? turns[0]?.role;
          const index = tagIndex(everyone, participantId);
          return (
            <div className="lane" key={participantId} data-tag={index}>
              <div className="chat__meta">
                <EarTag model={model} index={index} />
                {role != null && <span className="badge">{role}</span>}
              </div>
              {turns.map((message) => (
                <Turn key={message.messageId} message={message} everyone={everyone} inLane />
              ))}
              {turns.length === 0 && (
                <p className="lane__waiting">
                  {info?.status === 'open' ? 'Writing its answer…' : 'Did not speak in this round.'}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {notes.length > 0 && (
        <div className="round__notes">
          {notes.map((message) => (
            <Turn key={message.messageId} message={message} everyone={everyone} />
          ))}
        </div>
      )}
    </li>
  );
}

/** Past this, a turn is folded until asked for, so lanes stay comparable. */
const FOLD_AT = 1_400;

function Turn({
  message,
  everyone,
  inLane = false,
}: {
  message: Message;
  everyone: readonly RosterEntry[];
  /** The lane already names the model and its role; do not say it twice. */
  inLane?: boolean;
}): ReactElement {
  const [unfolded, setUnfolded] = useState(false);
  const text = message.body.kind === 'text' ? message.body.text : '';
  const long = text.length > FOLD_AT;

  return (
    <div className="chat__turn" data-author={message.author.kind}>
      <div className="chat__meta">
        {!inLane &&
          (message.author.kind === 'MODEL' ? (
            <EarTag
              model={message.author.model}
              index={tagIndex(everyone, message.author.participantId)}
            />
          ) : (
            <span className="chat__who">{message.author.kind === 'HUMAN' ? 'You' : 'Sheep'}</span>
          ))}
        {!inLane && message.role !== null && <span className="badge">{message.role}</span>}
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
      <p className="chat__body" data-folded={long && !unfolded ? 'true' : undefined}>
        {message.body.kind !== 'text' ? (
          '(stored as a blob)'
        ) : text === '' ? (
          <span className="chat__empty">
            {message.finish === 'cancelled' ? 'stopped before the model said anything' : 'no text'}
          </span>
        ) : (
          text
        )}
      </p>
      {long && (
        <button
          type="button"
          className="chat__more"
          onClick={() => {
            setUnfolded(!unfolded);
          }}
        >
          {unfolded ? 'Fold' : 'Read all'}
        </button>
      )}
    </div>
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

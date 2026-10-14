import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { Message, ModelRef, RosterEntry, SessionSummary } from '@sheep/core';
import type { IpcClient, StreamEvent } from '@sheep/ipc';
import { paneById } from '@shared/panes';
import {
  ACCEPT,
  formatBytes,
  isImage,
  readAttachment,
  type OutgoingAttachment,
} from '../components/attachments';
import { EarTag, tagIndex } from '../components/EarTag';
import { Markdown } from '../components/Markdown';
import type { PhaseView } from '../components/PhaseTrack';
import { ProtocolPanel } from './ProtocolPanel';

/** A run in flight: what has arrived so far. Queued until its model starts. */
interface LiveRun {
  readonly runId: string;
  readonly messageId: string;
  readonly participantId: string;
  /** The model a private run is with; null for the room. */
  readonly privateTo: string | null;
  readonly started: boolean;
  readonly text: string;
  readonly reasoning: string;
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

type SendInput = {
  participantId?: string;
  private?: boolean;
  text?: string;
  attachments?: OutgoingAttachment[];
};

/** What the person typed and attached, as a send: an empty part is left out, not sent empty. */
function said(text: string, files: OutgoingAttachment[]): SendInput {
  return {
    ...(text === '' ? {} : { text }),
    ...(files.length === 0 ? {} : { attachments: files }),
  };
}

/** Everyone, in the "to" picker. A participant id otherwise. */
const EVERYONE = 'everyone';

/**
 * Where the models talk: a chat room every attached model reads and answers
 * in, a private thread with each one, and the protocol's own rounds beside.
 *
 * In the room a message is answered by every model in turn, each having read
 * the others, so they answer each other as well as the person. A private
 * message is between the person and one model, in a window of its own, and no
 * other model ever sees it.
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
  const [view, setView] = useState<'chat' | 'protocol'>('chat');
  const [to, setTo] = useState(EVERYONE);
  const [privateWith, setPrivateWith] = useState<string | null>(null);
  const [live, setLive] = useState<ReadonlyMap<string, LiveRun>>(new Map());
  const [problem, setProblem] = useState<string | null>(null);

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

  const everyone = state.kind === 'ready' ? state.everyone : [];
  const roster = state.kind === 'ready' ? state.roster : [];
  const nameOf = useCallback(
    (participantId: string): string =>
      everyone.find((entry) => entry.participantId === participantId)?.model.modelId ?? 'a model',
    [everyone],
  );

  /**
   * The stream.
   *
   * Subscribed once for the pane's lifetime rather than per run: a room of
   * models and any private threads share one channel.
   */
  useEffect(() => {
    if (!client) return;
    return client.on(
      'sheep:stream-event',
      (event: StreamEvent) => {
        setLive((current) => {
          const run = current.get(event.runId);
          const next = new Map(current);
          switch (event.kind) {
            case 'start':
              next.set(event.runId, {
                runId: event.runId,
                messageId: event.messageId,
                participantId: event.participantId,
                privateTo: run?.privateTo ?? null,
                text: run?.text ?? '',
                reasoning: run?.reasoning ?? '',
                started: true,
              });
              return next;
            case 'text':
              if (!run) return current;
              next.set(event.runId, { ...run, started: true, text: run.text + event.text });
              return next;
            case 'reasoning':
              if (!run) return current;
              next.set(event.runId, {
                ...run,
                started: true,
                reasoning: run.reasoning + event.text,
              });
              return next;
            case 'end':
              // The message is in the log now; re-reading the projection is
              // what makes it real on screen, so the live copy goes away.
              next.delete(event.runId);
              return next;
            default:
              return current;
          }
        });

        if (event.kind === 'error') setProblem(event.message);
        if (event.kind === 'end') {
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

  /** Sends, and shows every model the send will hear from as waiting its turn. */
  const send = useCallback(
    async (input: SendInput): Promise<boolean> => {
      if (!client || sessionId === null) return false;
      setProblem(null);
      try {
        const reply = await client.invoke('sheep:chat-send', { sessionId, ...input });
        const privateTo = input.private === true ? (input.participantId ?? null) : null;
        setLive((current) => {
          const next = new Map(current);
          for (const run of reply.runs) {
            // A run can start before this reply lands; keep what it has said.
            const known = next.get(run.runId);
            next.set(run.runId, {
              runId: run.runId,
              messageId: run.assistantMessageId,
              participantId: run.participantId,
              started: known?.started ?? false,
              text: known?.text ?? '',
              reasoning: known?.reasoning ?? '',
              privateTo,
            });
          }
          return next;
        });
        void load();
        onStoreChanged();
        return true;
      } catch (error) {
        setProblem(describe(error));
        return false;
      }
    },
    [client, sessionId, load, onStoreChanged],
  );

  /** Stopping one run of a send stops the rest of it; every send in view is stopped. */
  const stop = useCallback(
    (privateTo: string | null): void => {
      if (!client) return;
      for (const run of live.values()) {
        if (run.privateTo !== privateTo) continue;
        void client.invoke('sheep:chat-cancel', { runId: run.runId }).catch((error: unknown) => {
          setProblem(describe(error));
        });
      }
    },
    [client, live],
  );

  const messages = state.kind === 'ready' ? state.messages : [];
  const room = useMemo(
    () => messages.filter((message) => message.phaseId === null && message.privateTo === null),
    [messages],
  );
  const runs = [...live.values()];
  const roomRuns = runs.filter((run) => run.privateTo === null);
  const blocks = useMemo(
    () => intoBlocks(messages).filter((block) => block.kind === 'round'),
    [messages],
  );
  const rounds = useMemo(
    () => (state.kind === 'ready' ? roundIndex(state.phases) : new Map<string, RoundInfo>()),
    [state],
  );
  const target = roster.find((entry) => entry.participantId === to);

  return (
    <section
      className="pane pane--wide talk-pane"
      data-pane="conversation"
      data-sheep-conversation={state.kind}
      data-sheep-messages={state.kind === 'ready' ? String(messages.length) : ''}
      data-sheep-streaming={live.size === 0 ? 'idle' : 'streaming'}
    >
      <header className="talk-pane__head">
        <div>
          <h1 className="pane__title">{pane.label}</h1>
          {state.kind === 'ready' && <p className="pane__summary">{state.session.title}</p>}
        </div>
        {state.kind === 'ready' && (
          <div className="talk-pane__tabs" role="tablist" aria-label="View">
            {(['chat', 'protocol'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                className="talk-pane__tab"
                aria-selected={view === option}
                onClick={() => {
                  setView(option);
                }}
              >
                {option === 'chat' ? 'Chat' : 'Protocol'}
              </button>
            ))}
          </div>
        )}
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

      {state.kind === 'ready' && view === 'protocol' && (
        <>
          <ProtocolPanel
            client={client}
            sessionId={state.session.sessionId}
            onStoreChanged={() => {
              void load();
              onStoreChanged();
            }}
          />
          <ol className="chat">
            {blocks.map((block) =>
              block.kind === 'round' ? (
                <RoundBlock
                  key={block.roundId}
                  messages={block.messages}
                  info={rounds.get(block.roundId)}
                  everyone={everyone}
                />
              ) : null,
            )}
          </ol>
        </>
      )}

      {state.kind === 'ready' && view === 'chat' && roster.length === 0 && (
        <div className="empty">
          <p className="empty__title">No models attached</p>
          <p className="empty__body">
            Attach at least one model to this session&rsquo;s roster before asking it anything.
          </p>
        </div>
      )}

      {state.kind === 'ready' && view === 'chat' && roster.length > 0 && (
        <div className="talk">
          <div className="talk__people" aria-label="Models in this chat">
            {roster.map((entry) => (
              <button
                key={entry.participantId}
                type="button"
                className="talk__person"
                title={`Message ${entry.model.modelId} privately`}
                onClick={() => {
                  setPrivateWith(entry.participantId);
                }}
              >
                <EarTag model={entry.model} index={tagIndex(everyone, entry.participantId)} />
                <span className="talk__person-action">Private chat</span>
              </button>
            ))}
          </div>

          <Thread
            client={client}
            messages={room}
            runs={roomRuns}
            everyone={everyone}
            empty={
              roster.length > 1
                ? 'Ask the room something. Every model answers in turn, and each one reads what the others said before it does.'
                : 'Ask this model something. Attach another to have them talk to each other.'
            }
          />

          {problem !== null && privateWith === null && (
            <p className="notice notice--error" role="alert">
              {problem}
            </p>
          )}

          <Composer
            primary
            busy={roomRuns.length > 0}
            placeholder={
              target ? `Message ${target.model.modelId} (everyone sees it)` : 'Message everyone'
            }
            onSend={(text, files) =>
              send({ ...(to === EVERYONE ? {} : { participantId: to }), ...said(text, files) })
            }
            onStop={() => {
              stop(null);
            }}
          >
            <label className="talk__to">
              <span>To</span>
              <select
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                }}
              >
                <option value={EVERYONE}>Everyone</option>
                {roster.map((entry) => (
                  <option key={entry.participantId} value={entry.participantId}>
                    {entry.model.modelId}
                  </option>
                ))}
              </select>
            </label>
            {roster.length > 1 && (
              <button
                type="button"
                className="talk__chip"
                disabled={roomRuns.length > 0 || room.length === 0}
                title="Another round of answers, with nothing new from you"
                onClick={() => {
                  void send({});
                }}
              >
                Let them discuss
              </button>
            )}
          </Composer>
        </div>
      )}

      {state.kind === 'ready' && privateWith !== null && (
        <PrivateChat
          client={client}
          participant={everyone.find((entry) => entry.participantId === privateWith)}
          index={tagIndex(everyone, privateWith)}
          messages={messages.filter(
            (message) => message.phaseId === null && message.privateTo === privateWith,
          )}
          runs={runs.filter((run) => run.privateTo === privateWith)}
          everyone={everyone}
          problem={problem}
          onSend={(text, files) =>
            send({ participantId: privateWith, private: true, ...said(text, files) })
          }
          onStop={() => {
            stop(privateWith);
          }}
          onClose={() => {
            setPrivateWith(null);
            setProblem(null);
          }}
          nameOf={nameOf}
        />
      )}
    </section>
  );
}

/** One conversation, oldest first, with whatever is still being written at the end. */
function Thread({
  client,
  messages,
  runs,
  everyone,
  empty,
}: {
  client: IpcClient | undefined;
  messages: readonly Message[];
  runs: readonly LiveRun[];
  everyone: readonly RosterEntry[];
  empty: string;
}): ReactElement {
  const bottom = useRef<HTMLDivElement | null>(null);
  const streamed = runs.map((run) => run.text.length + run.reasoning.length).join();
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, runs.length, streamed]);

  return (
    <ol className="talk__thread">
      {messages.length === 0 && runs.length === 0 && <li className="talk__hello">{empty}</li>}
      {messages.map((message) => (
        <ChatMessage
          key={message.messageId}
          client={client}
          message={message}
          everyone={everyone}
        />
      ))}
      {runs.map((run) => {
        const model = everyone.find((entry) => entry.participantId === run.participantId)?.model;
        const index = tagIndex(everyone, run.participantId);
        return run.started ? (
          <li
            key={run.runId}
            className="talk__msg chat__turn--live"
            data-author="MODEL"
            data-tag={index}
          >
            <Speaker model={model} index={index}>
              <span className="talk__typing" aria-label="writing" />
            </Speaker>
            {run.reasoning !== '' && <Thinking text={run.reasoning} live={run.text === ''} />}
            <div className="chat__body talk__body">
              <Markdown text={run.text} />
            </div>
          </li>
        ) : (
          <li key={run.runId} className="talk__msg talk__msg--waiting" data-author="MODEL">
            <Speaker model={model} index={index}>
              <span className="talk__note">waiting for its turn…</span>
            </Speaker>
          </li>
        );
      })}
      <div ref={bottom} />
    </ol>
  );
}

function Speaker({
  model,
  index,
  children,
}: {
  model: ModelRef | undefined;
  index: number;
  children?: ReactNode;
}): ReactElement {
  return (
    <div className="talk__speaker">
      {model ? <EarTag model={model} index={index} /> : <span className="chat__who">model</span>}
      {model && <span className="talk__vendor">{model.vendorId}</span>}
      {children}
    </div>
  );
}

function ChatMessage({
  client,
  message,
  everyone,
}: {
  client: IpcClient | undefined;
  message: Message;
  everyone: readonly RosterEntry[];
}): ReactElement {
  const text = message.body.kind === 'text' ? message.body.text : '(stored as a blob)';
  if (message.summaryThrough !== null) {
    // What the models read in place of the turns above it, folded like thinking.
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
    return (
      <li className="talk__msg talk__msg--summary" data-author="SYSTEM">
        <details className="think">
          <summary className="think__summary">
            <span className="think__label">Earlier conversation summarized</span>
            <span className="think__count">{words} words</span>
          </summary>
          <div className="think__body">{text}</div>
        </details>
      </li>
    );
  }
  if (message.author.kind !== 'MODEL') {
    return (
      <li className="talk__msg" data-author={message.author.kind}>
        <Attachments
          client={client}
          messageId={message.messageId}
          attachments={message.attachments}
        />
        {text !== '' && <div className="talk__bubble">{text}</div>}
      </li>
    );
  }
  const index = tagIndex(everyone, message.author.participantId);
  return (
    <li className="talk__msg" data-author="MODEL" data-tag={index}>
      <Speaker model={message.author.model} index={index}>
        {message.finish !== null && message.finish !== 'stop' && (
          <span className="badge" data-status={finishStatus(message.finish)}>
            {message.finish}
          </span>
        )}
      </Speaker>
      {message.reasoning !== null && <Thinking text={message.reasoning} />}
      <div className="talk__body">
        {text === '' ? (
          <p className="chat__empty">
            {message.finish === 'cancelled'
              ? 'stopped before it said anything'
              : message.reasoning !== null
                ? 'it ran out of room while thinking, before it answered'
                : 'no text'}
          </p>
        ) : (
          <Markdown text={text} />
        )}
      </div>
      {message.usage !== null && (
        <p className="talk__usage">
          {message.usage.inputTokens} in · {message.usage.outputTokens} out ·{' '}
          {formatUsd(message.usage.costUsd)}
        </p>
      )}
    </li>
  );
}

/** The box at the bottom: grows with what is typed; Enter sends, Shift+Enter breaks a line. */
function Composer({
  placeholder,
  busy,
  primary = false,
  onSend,
  onStop,
  children,
}: {
  placeholder: string;
  busy: boolean;
  /** The room's composer: the one the launch checks type into. */
  primary?: boolean;
  /** Resolves false when the message did not leave, so it is given back. */
  onSend: (text: string, files: OutgoingAttachment[]) => Promise<boolean>;
  onStop: () => void;
  children?: ReactNode;
}): ReactElement {
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<readonly Picked[]>([]);
  const [reading, setReading] = useState(false);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  // A preview's object URL is the page's to free, once nothing shows it.
  useEffect(
    () => () => {
      for (const picked of files) if (picked.preview) URL.revokeObjectURL(picked.preview);
    },
    [files],
  );

  const add = (list: FileList | readonly File[]): void => {
    const incoming = [...list];
    if (incoming.length === 0) return;
    setFileProblem(null);
    setFiles((current) => {
      const room = Math.max(0, MAX_FILES - current.length);
      if (incoming.length > room) setFileProblem(`At most ${String(MAX_FILES)} files a message.`);
      return [
        ...current,
        ...incoming.slice(0, room).map((file) => ({
          id: `${file.name}-${String(file.size)}-${String(Math.random())}`,
          file,
          preview: isImage(file) ? URL.createObjectURL(file) : null,
        })),
      ];
    });
  };

  const submit = (): void => {
    const text = draft.trim();
    if ((text === '' && files.length === 0) || busy || reading) return;
    setReading(true);
    setFileProblem(null);
    void Promise.all(files.map((picked) => readAttachment(picked.file)))
      .then(async (outgoing) => {
        const kept = files;
        setDraft('');
        setFiles([]);
        if (!(await onSend(text, outgoing))) {
          setDraft(text);
          setFiles(kept);
        }
      })
      .catch((error: unknown) => {
        setFileProblem(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setReading(false);
      });
  };

  return (
    <form
      className="talk__composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        add(event.dataTransfer.files);
      }}
    >
      {files.length > 0 && (
        <ul className="talk__files">
          {files.map((picked) => (
            <li key={picked.id} className="talk__file">
              {picked.preview ? (
                <img className="talk__file-thumb" src={picked.preview} alt="" />
              ) : (
                <span className="talk__file-icon" aria-hidden="true">
                  {picked.file.name.split('.').pop()?.slice(0, 4).toUpperCase() ?? 'FILE'}
                </span>
              )}
              <span className="talk__file-name">{picked.file.name}</span>
              <button
                type="button"
                className="talk__file-remove"
                aria-label={`Remove ${picked.file.name}`}
                onClick={() => {
                  setFiles((current) => current.filter((entry) => entry.id !== picked.id));
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {fileProblem !== null && (
        <p className="talk__file-problem" role="alert">
          {fileProblem}
        </p>
      )}
      <textarea
        className="talk__input"
        rows={1}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onPaste={(event) => {
          // A pasted screenshot arrives as a file; text pastes as text.
          if (event.clipboardData.files.length > 0) {
            event.preventDefault();
            add(event.clipboardData.files);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="talk__tools">
        <input
          ref={picker}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(event) => {
            if (event.target.files) add(event.target.files);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className="talk__attach"
          aria-label="Attach images or files"
          title="Attach images, PDFs or text files (or drop or paste them here)"
          onClick={() => {
            picker.current?.click();
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M21 11.5l-8.5 8.5a5 5 0 01-7-7L14 4.5a3.5 3.5 0 015 5L10.5 18a2 2 0 01-3-3L15 7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {children}
        <span className="talk__spacer" />
        {busy ? (
          <button
            type="button"
            className="talk__send talk__send--stop"
            data-sheep-cancel={primary ? 'true' : undefined}
            aria-label="Stop"
            title="Stop"
            onClick={onStop}
          >
            <span aria-hidden="true">■</span>
          </button>
        ) : (
          <button
            type="submit"
            className="talk__send"
            data-sheep-send={primary ? 'true' : undefined}
            aria-label="Send"
            title="Send (Enter)"
            disabled={(draft.trim() === '' && files.length === 0) || reading}
          >
            <span aria-hidden="true">{reading ? '…' : '↑'}</span>
          </button>
        )}
      </div>
    </form>
  );
}

/** A file picked for the next message, with a preview while it waits. */
interface Picked {
  readonly id: string;
  readonly file: File;
  readonly preview: string | null;
}

/** As many as one message carries; the main process holds the same line. */
const MAX_FILES = 6;

/**
 * What a model thought before it answered, folded to one line.
 *
 * Folded, always: the answer is what the chat shows. While the model is still
 * thinking the line says so and counts as it goes; a click opens the thinking
 * itself, live or finished.
 */
function Thinking({ text, live = false }: { text: string; live?: boolean }): ReactElement {
  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
  return (
    <details className="think" data-live={live ? 'true' : undefined}>
      <summary className="think__summary">
        <span className="think__label">{live ? 'Thinking' : 'Thought'}</span>
        <span className="think__count">{words} words</span>
      </summary>
      <div className="think__body">{text}</div>
    </details>
  );
}

/** The files a person sent, as thumbnails and labels; fetched from the store when shown. */
function Attachments({
  client,
  messageId,
  attachments,
}: {
  client: IpcClient | undefined;
  messageId: string;
  attachments: Message['attachments'];
}): ReactElement | null {
  if (attachments.length === 0) return null;
  return (
    <ul className="talk__sent-files">
      {attachments.map((file) =>
        file.mediaType.startsWith('image/') ? (
          <li key={file.hash}>
            <SentImage client={client} messageId={messageId} hash={file.hash} name={file.name} />
          </li>
        ) : (
          <li key={file.hash} className="talk__file talk__file--sent">
            <span className="talk__file-icon" aria-hidden="true">
              {file.name.split('.').pop()?.slice(0, 4).toUpperCase() ?? 'FILE'}
            </span>
            <span className="talk__file-name">{file.name}</span>
            <span className="talk__file-size">{formatBytes(file.bytes)}</span>
          </li>
        ),
      )}
    </ul>
  );
}

function SentImage({
  client,
  messageId,
  hash,
  name,
}: {
  client: IpcClient | undefined;
  messageId: string;
  hash: string;
  name: string;
}): ReactElement {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client
      .invoke('sheep:message-attachment', { messageId, hash })
      .then((reply) => {
        if (!cancelled) setSource(`data:${reply.mediaType};base64,${reply.base64}`);
      })
      .catch(() => {
        // The label below still says what was sent.
      });
    return () => {
      cancelled = true;
    };
  }, [client, messageId, hash]);
  return source === null ? (
    <span className="talk__file talk__file--sent">{name}</span>
  ) : (
    <img className="talk__sent-image" src={source} alt={name} title={name} />
  );
}

/** A private thread with one model, in a window over the room. */
function PrivateChat({
  client,
  participant,
  index,
  messages,
  runs,
  everyone,
  problem,
  onSend,
  onStop,
  onClose,
  nameOf,
}: {
  client: IpcClient | undefined;
  participant: RosterEntry | undefined;
  index: number;
  messages: readonly Message[];
  runs: readonly LiveRun[];
  everyone: readonly RosterEntry[];
  problem: string | null;
  onSend: (text: string, files: OutgoingAttachment[]) => Promise<boolean>;
  onStop: () => void;
  onClose: () => void;
  nameOf: (participantId: string) => string;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  const name = participant ? participant.model.modelId : 'this model';

  return (
    <dialog ref={dialog} className="dm" onClose={onClose} aria-label={`Private chat with ${name}`}>
      <header className="dm__head">
        {participant && <EarTag model={participant.model} index={index} />}
        <span className="dm__note">
          Private. The other models never see this, and nothing here becomes a claim.
        </span>
        <button
          type="button"
          className="dm__close"
          aria-label="Close"
          onClick={() => {
            dialog.current?.close();
          }}
        >
          ×
        </button>
      </header>
      <div className="dm__body">
        <Thread
          client={client}
          messages={messages}
          runs={runs}
          everyone={everyone}
          empty={`Ask ${nameOf(participant?.participantId ?? '')} something only it will see.`}
        />
      </div>
      {problem !== null && (
        <p className="notice notice--error" role="alert">
          {problem}
        </p>
      )}
      <Composer
        busy={runs.length > 0}
        placeholder={`Message ${name} privately`}
        onSend={onSend}
        onStop={onStop}
      />
    </dialog>
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

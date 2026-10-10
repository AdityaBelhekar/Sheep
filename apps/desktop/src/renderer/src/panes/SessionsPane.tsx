import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { SessionSummary } from '@sheep/core';
import type { IpcClient } from '@sheep/ipc';
import { paneById } from '@shared/panes';
import { RosterPanel } from './RosterPanel';

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; sessions: readonly SessionSummary[]; projectedThroughSeq: number }
  | { kind: 'error'; message: string };

/**
 * The sessions list, read from the `sessions` projection over IPC.
 *
 * This is the whole data path in one component: a click appends domain events to
 * the hash-chained log, the projection folds them into rows inside the same
 * transaction, and the reply carries the rows back. Nothing here queries
 * anything — the renderer is sandboxed and has no database to query.
 */
export function SessionsPane({
  client,
  onStoreChanged,
}: {
  client: IpcClient | undefined;
  /** Called after this pane appends events, so the shell can re-read the log. */
  onStoreChanged: () => void;
}): ReactElement {
  const pane = paneById('sessions');
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [title, setTitle] = useState('');
  const [question, setQuestion] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const [transferred, setTransferred] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(
    (signal?: { cancelled: boolean }) => {
      if (!client) {
        setState({ kind: 'error', message: 'the preload bridge is unavailable' });
        return;
      }
      client
        .invoke('sheep:sessions-list', {})
        .then((reply) => {
          if (signal?.cancelled) return;
          setState({
            kind: 'ready',
            sessions: reply.sessions,
            projectedThroughSeq: reply.projectedThroughSeq,
          });
        })
        .catch((error: unknown) => {
          if (signal?.cancelled) return;
          setState({ kind: 'error', message: describe(error) });
        });
    },
    [client],
  );

  /** Runs an export or an import, and says what happened. A closed dialog says nothing. */
  const transfer = (action: (ipc: IpcClient) => Promise<string | null>): void => {
    if (!client) return;
    setTransferred(null);
    action(client)
      .then((message) => {
        if (message === null) return;
        setTransferred({ ok: true, message });
        load();
        onStoreChanged();
      })
      .catch((error: unknown) => {
        setTransferred({ ok: false, message: describe(error) });
      });
  };

  useEffect(() => {
    const signal = { cancelled: false };
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  /**
   * Reopens the session the user was last looking at.
   *
   * Stored rather than remembered in component state, so closing the window and
   * coming back lands where the work was left rather than at the top of a list.
   */
  useEffect(() => {
    if (!client) return;
    const signal = { cancelled: false };
    client
      .invoke('sheep:settings-read', {})
      .then((reply) => {
        if (!signal.cancelled) setSelected(reply.settings['ui.lastSessionId']);
      })
      .catch(() => {
        // A settings read that fails simply means no session is preselected.
      });
    return () => {
      signal.cancelled = true;
    };
  }, [client]);

  const select = useCallback(
    (sessionId: string | null) => {
      setSelected(sessionId);
      void client?.invoke('sheep:settings-write', {
        key: 'ui.lastSessionId',
        value: sessionId,
      });
    },
    [client],
  );

  const canCreate = client !== undefined && title.trim() !== '' && question.trim() !== '';

  const create = (): void => {
    if (!client || !canCreate) return;
    setCreating(true);
    client
      .invoke('sheep:session-create', { title: title.trim(), question: question.trim() })
      .then((reply) => {
        setState({
          kind: 'ready',
          sessions: reply.sessions,
          projectedThroughSeq: reply.projectedThroughSeq,
        });
        setTitle('');
        setQuestion('');
        select(reply.sessionId);
        onStoreChanged();
      })
      .catch((error: unknown) => {
        setState({ kind: 'error', message: describe(error) });
      })
      .finally(() => {
        setCreating(false);
      });
  };

  const count = state.kind === 'ready' ? state.sessions.length : -1;

  return (
    <section
      className="pane"
      data-pane="sessions"
      data-sheep-sessions={state.kind === 'ready' ? String(count) : state.kind}
      data-sheep-projected-seq={state.kind === 'ready' ? String(state.projectedThroughSeq) : ''}
    >
      <header className="pane__header">
        <h1 className="pane__title">{pane.label}</h1>
        <p className="pane__summary">{pane.summary}</p>
      </header>

      <form
        className="new-session"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="new-session-title">
            Title
          </label>
          <input
            id="new-session-title"
            className="field__input"
            value={title}
            maxLength={200}
            placeholder="Block-sparse attention at long context"
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="new-session-question">
            Research question
          </label>
          <textarea
            id="new-session-question"
            className="field__input field__input--multiline"
            value={question}
            rows={2}
            placeholder="Does block-sparse attention preserve perplexity at 128k context?"
            onChange={(event) => {
              setQuestion(event.target.value);
            }}
          />
        </div>

        <div className="button-row">
          <button className="button" type="submit" disabled={!canCreate || creating}>
            {creating ? 'Creating…' : 'New session'}
          </button>
          <button
            className="button button--quiet"
            type="button"
            data-sheep-import-session
            onClick={() => {
              transfer(async (ipc) => {
                const { imported } = await ipc.invoke('sheep:session-import', {});
                return imported === null
                  ? null
                  : `Imported “${imported.title}”: ${String(imported.events)} events and ${String(
                      imported.blobs,
                    )} files, checked against their hashes and the ledger’s rules.`;
              });
            }}
          >
            Import session…
          </button>
        </div>
      </form>

      {transferred !== null && (
        <p
          className={transferred.ok ? 'notice' : 'notice notice--error'}
          role={transferred.ok ? 'status' : 'alert'}
          data-sheep-session-transfer={transferred.ok ? 'ok' : 'refused'}
        >
          {transferred.message}
        </p>
      )}

      {state.kind === 'loading' && <p className="notice">Reading the sessions projection…</p>}

      {state.kind === 'error' && (
        <p className="notice notice--error" role="alert">
          Could not read the projection: {state.message}
        </p>
      )}

      {state.kind === 'ready' && state.sessions.length === 0 && (
        <div className="empty">
          <p className="empty__title">No sessions yet</p>
          <p className="empty__body">
            A session is one research question with a roster of models attached. Nothing is stored
            until you create one — the list above is a live read of the projection, not a cache.
          </p>
        </div>
      )}

      {state.kind === 'ready' && state.sessions.length > 0 && (
        <ul className="session-list">
          {state.sessions.map((session) => (
            <li
              className="session"
              key={session.sessionId}
              data-sheep-selected={session.sessionId === selected ? 'true' : undefined}
            >
              <div className="session__head">
                <h2 className="session__title">{session.title}</h2>
                <span className="badge" data-status={session.status}>
                  {session.status}
                </span>
              </div>
              <p className="session__question">{session.question}</p>
              <dl className="session__meta">
                <div>
                  <dt>Created</dt>
                  <dd>{formatTimestamp(session.createdAt)}</dd>
                </div>
                <div>
                  <dt>Roster</dt>
                  <dd>{session.participantCount}</dd>
                </div>
                <div>
                  <dt>Messages</dt>
                  <dd>{session.messageCount}</dd>
                </div>
                <div>
                  <dt>Spend</dt>
                  <dd>
                    {formatUsd(session.budget.spentUsd)}
                    {session.budget.capUsd === null
                      ? ' · no cap'
                      : ` of ${formatUsd(session.budget.capUsd)}`}
                  </dd>
                </div>
              </dl>

              <div className="button-row">
                <button
                  className="button button--quiet"
                  type="button"
                  data-sheep-open-session={session.sessionId}
                  onClick={() => {
                    select(session.sessionId === selected ? null : session.sessionId);
                  }}
                >
                  {session.sessionId === selected ? 'Hide roster' : 'Roster'}
                </button>
                <button
                  className="button button--quiet"
                  type="button"
                  data-sheep-export-session={session.sessionId}
                  onClick={() => {
                    transfer(async (ipc) => {
                      const reply = await ipc.invoke('sheep:session-export', {
                        sessionId: session.sessionId,
                      });
                      return reply.saved
                        ? `Saved “${session.title}” to ${reply.path ?? ''}.`
                        : null;
                    });
                  }}
                >
                  Export
                </button>
              </div>

              {session.sessionId === selected && (
                <RosterPanel
                  client={client}
                  sessionId={session.sessionId}
                  onStoreChanged={() => {
                    load();
                    onStoreChanged();
                  }}
                  onClose={() => {
                    select(null);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="pane__note">{pane.arriving}.</p>
    </section>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

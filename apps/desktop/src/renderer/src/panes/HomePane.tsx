import { useEffect, useState, type ReactElement } from 'react';
import type { SessionSummary } from '@sheep/core';
import type { IpcClient } from '@sheep/ipc';
import logoUrl from '@resources/sheep.png';
import { APP_NAME } from '@shared/product';
import type { PaneId } from '@shared/panes';

/** How many past sessions the start page offers before sending you to the full list. */
const RECENT = 6;

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; sessions: readonly SessionSummary[] }
  | { kind: 'error'; message: string };

/**
 * Where the app opens: ask a new question, or go back to an old one.
 *
 * A question typed here becomes a session and lands on its roster, because a
 * session cannot run until models from two vendors are attached. An old
 * session opens where its work is: the protocol if it has models, the roster
 * if it does not.
 */
export function HomePane({
  client,
  onNavigate,
  onStoreChanged,
}: {
  client: IpcClient | undefined;
  onNavigate: (id: PaneId) => void;
  onStoreChanged: () => void;
}): ReactElement {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!client) {
      setState({ kind: 'error', message: 'the app could not reach its own back end' });
      return;
    }
    let cancelled = false;
    client
      .invoke('sheep:sessions-list', {})
      .then((reply) => {
        if (!cancelled) setState({ kind: 'ready', sessions: reply.sessions });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: describe(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const open = async (sessionId: string, to: PaneId): Promise<void> => {
    await client?.invoke('sheep:settings-write', { key: 'ui.lastSessionId', value: sessionId });
    onStoreChanged();
    onNavigate(to);
  };

  const start = (): void => {
    const asked = question.trim();
    if (!client || asked === '' || busy) return;
    setBusy(true);
    setProblem(null);
    client
      .invoke('sheep:session-create', { title: titleFrom(asked), question: asked })
      .then((reply) => open(reply.sessionId, 'sessions'))
      .catch((error: unknown) => {
        setProblem(describe(error));
        setBusy(false);
      });
  };

  const sessions = state.kind === 'ready' ? state.sessions : [];
  // Newest first, whatever order the list arrived in.
  const recent = [...sessions]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, RECENT);

  return (
    <section
      className="pane home"
      data-pane="home"
      data-sheep-sessions={state.kind === 'ready' ? String(sessions.length) : state.kind}
    >
      <header className="home__hero">
        <img className="home__logo" src={logoUrl} alt="" width={132} height={132} />
        <h1 className="home__title">{APP_NAME}</h1>
        <p className="home__tagline">Research you can check.</p>
      </header>

      <form
        className="home__ask"
        onSubmit={(event) => {
          event.preventDefault();
          start();
        }}
      >
        <textarea
          className="home__question"
          aria-label="Research question"
          rows={2}
          maxLength={2000}
          placeholder="What do you want to find out?"
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              start();
            }
          }}
        />
        <div className="home__ask-foot">
          <span className="home__hint">Needs models from two vendors.</span>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              onNavigate('connections');
            }}
          >
            Connections
          </button>
          <button className="button" type="submit" disabled={question.trim() === '' || busy}>
            {busy ? 'Starting…' : 'Start a session'}
          </button>
        </div>
      </form>

      {problem !== null && (
        <p className="notice notice--error" role="alert">
          {problem}
        </p>
      )}

      {state.kind === 'error' && (
        <p className="notice notice--error" role="alert">
          Could not load your sessions: {state.message}
        </p>
      )}

      {recent.length > 0 && (
        <div className="home__recent">
          <div className="split__bar">
            <h2 className="split__heading">Recent sessions</h2>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => {
                onNavigate('sessions');
              }}
            >
              All sessions
            </button>
          </div>
          <ul className="home__list">
            {recent.map((session) => (
              <li key={session.sessionId}>
                <button
                  type="button"
                  className="home__session"
                  data-sheep-home-session={session.sessionId}
                  onClick={() => {
                    void open(
                      session.sessionId,
                      session.participantCount > 0 ? 'conversation' : 'sessions',
                    );
                  }}
                >
                  <span className="home__session-question">{session.question}</span>
                  <span className="home__session-meta">
                    <span className="badge" data-status={session.status}>
                      {session.status}
                    </span>
                    {session.title} · {formatDate(session.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** A session needs a title; a question cut at a word is a fair one. */
function titleFrom(question: string): string {
  const line = question.replace(/\s+/g, ' ');
  if (line.length <= 70) return line;
  const cut = line.slice(0, 70);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40))}…`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { defaultSettings, type RosterEntry, type SessionSummary, type Theme } from '@sheep/core';
import type { IpcClient, IpcResponse } from '@sheep/ipc';
import logoUrl from '@resources/sheep.png';
import { APP_NAME } from '@shared/product';
import { EarTag, tagIndex } from './components/EarTag';
import { PaneIcon } from './components/PaneIcon';
import { PhaseTrack, type PhaseView } from './components/PhaseTrack';
import { ThemeToggle } from './components/ThemeToggle';
import { UpdateControl } from './components/UpdateControl';
import { useIpcClient, useRoute, useSystemPrefersDark } from './hooks';
import {
  HOME_PANE,
  PANE_IDS,
  RESEARCH_PANES,
  UTILITY_PANES,
  type PaneDefinition,
  type PaneId,
} from '@shared/panes';
import { ArtifactsPane } from './panes/ArtifactsPane';
import { ConnectionsPane } from './panes/ConnectionsPane';
import { ConversationPane } from './panes/ConversationPane';
import { HomePane } from './panes/HomePane';
import { LabPane } from './panes/LabPane';
import { PaperPane } from './panes/PaperPane';
import { LedgerPane } from './panes/LedgerPane';
import { SessionsPane } from './panes/SessionsPane';
import { VerificationPane } from './panes/VerificationPane';

type LogState =
  | { kind: 'pending' }
  | { kind: 'ok'; summary: IpcResponse<'sheep:event-log-summary'> }
  | { kind: 'error'; message: string };

type PingState =
  | { kind: 'pending' }
  | { kind: 'ok'; roundTripMs: number; version: string }
  | { kind: 'error'; message: string };

export function App(): ReactElement {
  const client = useIpcClient();
  const { paneId, navigate } = useRoute();
  const [log, setLog] = useState<LogState>({ kind: 'pending' });
  const [ping, setPing] = useState<PingState>({ kind: 'pending' });
  const { theme, resolved, setTheme, ready: themeReady } = useTheme(client);
  const [revision, setRevision] = useState(0);
  const active = useActiveSession(client, `${String(revision)}:${paneId}`);

  /**
   * Re-reads the log summary.
   *
   * Exposed to the panes because anything that appends events changes what the
   * status bar is reporting, and a status bar that lags behind the store is
   * worse than none — it invites trusting a number that is no longer true.
   * The running head is re-read on the same signal, for the same reason.
   */
  const refreshLog = useCallback(() => {
    if (!client) return;
    setRevision((current) => current + 1);
    client
      .invoke('sheep:event-log-summary', {})
      .then((summary) => {
        setLog({ kind: 'ok', summary });
      })
      .catch((error: unknown) => {
        setLog({ kind: 'error', message: String(error) });
      });
  }, [client]);

  useEffect(() => {
    if (!client) {
      setLog({ kind: 'error', message: 'preload bridge unavailable' });
      setPing({ kind: 'error', message: 'preload bridge unavailable' });
      return;
    }
    let cancelled = false;

    client
      .invoke('sheep:event-log-summary', {})
      .then((summary) => {
        if (!cancelled) setLog({ kind: 'ok', summary });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLog({ kind: 'error', message: String(error) });
      });

    client
      .ping()
      .then((reply) => {
        if (!cancelled) {
          setPing({ kind: 'ok', roundTripMs: reply.roundTripMs, version: reply.version });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setPing({ kind: 'error', message: String(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [client]);

  const chainState =
    log.kind === 'ok' ? (log.summary.chain.ok ? 'ok' : 'error') : (log.kind as 'pending' | 'error');

  return (
    <div
      className="shell"
      data-sheep-ready="true"
      data-sheep-pane={paneId}
      data-sheep-panes={PANE_IDS.join(',')}
      data-sheep-chain={chainState}
      data-sheep-ping={ping.kind}
      data-sheep-theme={theme}
    >
      <nav className="nav" aria-label="Work surfaces">
        <div className="brand">
          <img className="brand__logo" src={logoUrl} alt="" width={30} height={30} />
          <span className="brand__name">{APP_NAME}</span>
        </div>

        <NavGroup panes={[HOME_PANE]} active={paneId} onNavigate={navigate} />
        <span className="nav__heading">The record</span>
        <NavGroup panes={RESEARCH_PANES} active={paneId} onNavigate={navigate} numbered />
        <span className="nav__spacer" />
        <NavGroup panes={UTILITY_PANES} active={paneId} onNavigate={navigate} />

        <div className="nav__foot">
          <ThemeToggle
            theme={theme}
            resolved={resolved}
            onChange={setTheme}
            disabled={!themeReady}
          />
        </div>
      </nav>

      {paneId !== 'home' && <RunningHead active={active} onNavigate={navigate} />}

      <main className="content">
        {paneId === 'home' && (
          <HomePane client={client} onNavigate={navigate} onStoreChanged={refreshLog} />
        )}
        {paneId === 'sessions' && <SessionsPane client={client} onStoreChanged={refreshLog} />}
        {paneId === 'conversation' && (
          <ConversationPane client={client} onStoreChanged={refreshLog} />
        )}
        {paneId === 'ledger' && <LedgerPane client={client} onStoreChanged={refreshLog} />}
        {paneId === 'lab' && <LabPane client={client} onStoreChanged={refreshLog} />}
        {paneId === 'verification' && (
          <VerificationPane client={client} onStoreChanged={refreshLog} />
        )}
        {paneId === 'artifacts' && <ArtifactsPane client={client} onStoreChanged={refreshLog} />}
        {paneId === 'paper' && <PaperPane client={client} />}
        {paneId === 'connections' && <ConnectionsPane client={client} />}
      </main>

      <footer className="statusbar">
        <span className="statusbar__item" data-status={chainState}>
          <span className="chainmark" data-chain={chainState} aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          {log.kind === 'pending' && 'checking the record…'}
          {log.kind === 'ok' &&
            `record ${
              log.summary.chain.ok
                ? 'intact'
                : `BROKEN (${String(log.summary.chain.failures.length)})`
            }`}
          {log.kind === 'error' && `the record could not be read: ${log.message}`}
        </span>
        {log.kind === 'ok' && (
          <>
            <span className="statusbar__item">
              {log.summary.count} event{log.summary.count === 1 ? '' : 's'}
            </span>
          </>
        )}
        <span className="statusbar__spacer" />
        <span className="statusbar__item" data-status={ping.kind}>
          {ping.kind === 'ok' && `v${ping.version}`}
          {ping.kind === 'error' && 'the app is not responding'}
        </span>
        <UpdateControl client={client} />
      </footer>
    </div>
  );
}

/**
 * The session, pinned.
 *
 * A paper carries its title on every page; this carries the question on every
 * surface, with who is in the flock, where the protocol stands and what has
 * been spent. It is read-only on purpose — the surfaces below are where
 * anything is changed.
 */
function RunningHead({
  active,
  onNavigate,
}: {
  active: ActiveSession | null;
  onNavigate: (id: PaneId) => void;
}): ReactElement {
  if (active === null) {
    return (
      <header className="runhead">
        <div className="runhead__what">
          <span className="runhead__kicker">No session open</span>
          <p className="runhead__question runhead__question--none">
            Open a session to pin its question here.
          </p>
        </div>
        <div className="runhead__side">
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              onNavigate('sessions');
            }}
          >
            Choose a session
          </button>
        </div>
      </header>
    );
  }

  const { session, roster, phases } = active;
  const { spentUsd, capUsd } = session.budget;
  const used = capUsd === null || capUsd === 0 ? 0 : Math.min(1, spentUsd / capUsd);

  return (
    <header className="runhead" data-sheep-active-session={session.sessionId}>
      <div className="runhead__what">
        <span className="runhead__kicker">
          <span className="badge" data-status={session.status}>
            {session.status}
          </span>
          {session.title}
        </span>
        <p className="runhead__question" title={session.question}>
          {session.question}
        </p>
      </div>

      <div className="runhead__side">
        <span className="runhead__tags">
          {roster
            .filter((entry) => entry.detachedAt === null)
            .map((entry) => (
              <EarTag
                key={entry.participantId}
                model={entry.model}
                index={tagIndex(roster, entry.participantId)}
                bare
              />
            ))}
        </span>

        <PhaseTrack phases={phases} mini />

        <div
          className="meter"
          data-level={used >= 1 ? 'spent' : used >= 0.8 ? 'high' : 'ok'}
          title="Spent so far, against this session's cap"
        >
          <span>
            {formatUsd(spentUsd)}
            {capUsd === null ? ' · no cap' : ` / ${formatUsd(capUsd)}`}
          </span>
          {capUsd !== null && (
            <span className="meter__bar">
              <span className="meter__fill" style={{ width: `${String(used * 100)}%` }} />
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

function formatUsd(amount: number): string {
  return amount >= 0.01 || amount === 0 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}

interface ActiveSession {
  readonly session: SessionSummary;
  readonly roster: readonly RosterEntry[];
  readonly phases: readonly PhaseView[];
}

/**
 * The open session, for the running head.
 *
 * Re-read whenever `revision` moves — a pane appended events, or the route
 * changed — rather than patched from what a pane says it did: the same rule the
 * panes follow, for the same reason.
 */
function useActiveSession(client: IpcClient | undefined, revision: unknown): ActiveSession | null {
  const [active, setActive] = useState<ActiveSession | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;

    void (async () => {
      try {
        const sessionId = (await client.invoke('sheep:settings-read', {})).settings[
          'ui.lastSessionId'
        ];
        if (sessionId === null) {
          if (!cancelled) setActive(null);
          return;
        }
        const [detail, protocol] = await Promise.all([
          client.invoke('sheep:session-get', { sessionId }),
          // A session that has never run has no protocol state worth failing for.
          client.invoke('sheep:protocol-state', { sessionId }).catch(() => null),
        ]);
        if (cancelled) return;
        setActive({
          session: detail.session,
          roster: detail.roster,
          phases: protocol?.state.phases ?? [],
        });
      } catch {
        // The stored id can outlive its session; an empty head says so honestly.
        if (!cancelled) setActive(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, revision]);

  return active;
}

/** One block of navigation items, so the seven surfaces stay visibly seven. */
function NavGroup({
  panes,
  active,
  onNavigate,
  numbered = false,
}: {
  panes: readonly PaneDefinition[];
  active: PaneId;
  onNavigate: (id: PaneId) => void;
  /** The research surfaces are steps, and are numbered as steps. */
  numbered?: boolean;
}): ReactElement {
  return (
    <>
      {panes.map((pane, index) => (
        <button
          key={pane.id}
          type="button"
          className="nav__item"
          aria-current={pane.id === active ? 'page' : undefined}
          data-sheep-nav={pane.id}
          onClick={() => {
            onNavigate(pane.id as PaneId);
          }}
        >
          <PaneIcon pane={pane.id as PaneId} />
          <span className="nav__label">{pane.label}</span>
          {numbered && <span className="nav__index">{String(index + 1).padStart(2, '0')}</span>}
        </button>
      ))}
    </>
  );
}

/**
 * Theme state, persisted through the settings store.
 *
 * The stored preference is the source of truth, so it survives a restart; the
 * chosen value is applied to `document.documentElement` rather than passed down,
 * because CSS custom properties are what actually do the theming.
 */
function useTheme(client: IpcClient | undefined): {
  theme: Theme;
  resolved: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
  ready: boolean;
} {
  const [theme, setThemeState] = useState<Theme>(defaultSettings()['ui.theme']);
  const [ready, setReady] = useState(false);
  const prefersDark = useSystemPrefersDark();
  const resolved: 'light' | 'dark' = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    if (!client) return;
    let cancelled = false;

    client
      .invoke('sheep:settings-read', {})
      .then((reply) => {
        if (cancelled) return;
        setThemeState(reply.settings['ui.theme']);
        setReady(true);
      })
      .catch(() => {
        // A settings read that fails leaves the default in place; the app is
        // still usable, it simply will not remember the choice.
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    document.documentElement.dataset['theme'] = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const setTheme = (next: Theme): void => {
    setThemeState(next);
    void client?.invoke('sheep:settings-write', { key: 'ui.theme', value: next }).catch(() => {
      // Already applied locally; failing to persist is not worth interrupting for.
    });
  };

  return { theme, resolved, setTheme, ready };
}

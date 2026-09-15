import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { defaultSettings, type Theme } from '@sheep/core';
import type { IpcClient, IpcResponse } from '@sheep/ipc';
import logoUrl from '@resources/sheep.png';
import { APP_NAME } from '@shared/product';
import { PaneIcon } from './components/PaneIcon';
import { ThemeToggle } from './components/ThemeToggle';
import { useIpcClient, useRoute, useSystemPrefersDark } from './hooks';
import {
  PANE_IDS,
  RESEARCH_PANES,
  UTILITY_PANES,
  type PaneDefinition,
  type PaneId,
} from '@shared/panes';
import { ConnectionsPane } from './panes/ConnectionsPane';
import { ConversationPane } from './panes/ConversationPane';
import { LedgerPane } from './panes/LedgerPane';
import { SessionsPane } from './panes/SessionsPane';
import { StubPane } from './panes/StubPane';

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

  /**
   * Re-reads the log summary.
   *
   * Exposed to the panes because anything that appends events changes what the
   * status bar is reporting, and a status bar that lags behind the store is
   * worse than none — it invites trusting a number that is no longer true.
   */
  const refreshLog = useCallback(() => {
    if (!client) return;
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
      <header className="titlebar">
        <div className="brand">
          <img className="brand__logo" src={logoUrl} alt="" width={26} height={26} />
          <span className="brand__name">{APP_NAME}</span>
        </div>
        <ThemeToggle theme={theme} resolved={resolved} onChange={setTheme} disabled={!themeReady} />
      </header>

      <div className="body">
        <nav className="nav" aria-label="Work surfaces">
          <NavGroup panes={RESEARCH_PANES} active={paneId} onNavigate={navigate} />
          <span className="nav__spacer" />
          <NavGroup panes={UTILITY_PANES} active={paneId} onNavigate={navigate} />
        </nav>

        <main className="content">
          {paneId === 'sessions' && <SessionsPane client={client} onStoreChanged={refreshLog} />}
          {paneId === 'conversation' && (
            <ConversationPane client={client} onStoreChanged={refreshLog} />
          )}
          {paneId === 'ledger' && <LedgerPane client={client} onStoreChanged={refreshLog} />}
          {paneId === 'connections' && <ConnectionsPane client={client} />}
          {paneId !== 'sessions' &&
            paneId !== 'conversation' &&
            paneId !== 'ledger' &&
            paneId !== 'connections' && <StubPane paneId={paneId} />}
        </main>
      </div>

      <footer className="statusbar">
        <span className="statusbar__item" data-status={chainState}>
          {log.kind === 'pending' && 'verifying the event log…'}
          {log.kind === 'ok' &&
            `chain ${
              log.summary.chain.ok
                ? `verified to seq ${String(log.summary.head?.seq ?? 0)}`
                : `BROKEN (${String(log.summary.chain.failures.length)})`
            }`}
          {log.kind === 'error' && `event log unavailable: ${log.message}`}
        </span>
        {log.kind === 'ok' && (
          <>
            <span className="statusbar__item">
              {log.summary.count} event{log.summary.count === 1 ? '' : 's'}
            </span>
            <span className="statusbar__item">
              {log.summary.driver} · {log.summary.journalMode} · schema v{log.summary.schemaVersion}
            </span>
          </>
        )}
        <span className="statusbar__spacer" />
        <span className="statusbar__item" data-status={ping.kind}>
          {ping.kind === 'pending' && 'contacting main…'}
          {ping.kind === 'ok' && `main ${ping.version} · ${String(ping.roundTripMs)} ms`}
          {ping.kind === 'error' && 'main process unreachable'}
        </span>
        <span className="statusbar__item statusbar__item--muted">local-first · no telemetry</span>
      </footer>
    </div>
  );
}

/** One block of navigation items, so the seven surfaces stay visibly seven. */
function NavGroup({
  panes,
  active,
  onNavigate,
}: {
  panes: readonly PaneDefinition[];
  active: PaneId;
  onNavigate: (id: PaneId) => void;
}): ReactElement {
  return (
    <>
      {panes.map((pane) => (
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

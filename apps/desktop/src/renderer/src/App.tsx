import { useEffect, useState, type ReactElement } from 'react';
import { createIpcClient, type IpcClient, type IpcResponse } from '@sheep/ipc';
import logoUrl from '@resources/sheep.png';
import { APP_NAME, APP_TAGLINE } from '@shared/product';

type PingState =
  | { kind: 'pending' }
  | { kind: 'ok'; reply: IpcResponse<'sheep:ping'> & { roundTripMs: number } }
  | { kind: 'error'; message: string };

type LogState =
  | { kind: 'pending' }
  | { kind: 'ok'; summary: IpcResponse<'sheep:event-log-summary'> }
  | { kind: 'error'; message: string };

function useSheepClient(): IpcClient | undefined {
  const [client] = useState(() => {
    const bridge = window.sheep;
    if (!bridge) return undefined;
    return createIpcClient({ invoke: (channel, payload) => bridge.invoke(channel, payload) });
  });
  return client;
}

export function App(): ReactElement {
  const versions = window.sheep?.versions;
  const client = useSheepClient();
  const [ping, setPing] = useState<PingState>({ kind: 'pending' });
  const [log, setLog] = useState<LogState>({ kind: 'pending' });

  useEffect(() => {
    if (!client) {
      setPing({ kind: 'error', message: 'preload bridge unavailable' });
      setLog({ kind: 'error', message: 'preload bridge unavailable' });
      return;
    }

    let cancelled = false;

    client
      .ping()
      .then((reply) => {
        if (!cancelled) setPing({ kind: 'ok', reply });
      })
      .catch((error: unknown) => {
        if (!cancelled) setPing({ kind: 'error', message: String(error) });
      });

    client
      .invoke('sheep:event-log-summary', {})
      .then((summary) => {
        if (!cancelled) setLog({ kind: 'ok', summary });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLog({ kind: 'error', message: String(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [client]);

  const chainState =
    log.kind === 'ok'
      ? log.summary.chain.ok
        ? 'ok'
        : 'error'
      : log.kind === 'error'
        ? 'error'
        : 'pending';

  return (
    <main
      className="shell"
      data-sheep-ready="true"
      data-sheep-ping={ping.kind}
      data-sheep-chain={chainState}
    >
      <img
        className="shell__logo"
        src={logoUrl}
        alt={`${APP_NAME} logo`}
        width={160}
        height={160}
      />
      <h1 className="shell__title">{APP_NAME}</h1>
      <p className="shell__tagline">{APP_TAGLINE}</p>

      <p className="shell__status" data-status={ping.kind}>
        {ping.kind === 'pending' && 'contacting main process…'}
        {ping.kind === 'ok' &&
          `main process replied in ${String(ping.reply.roundTripMs)} ms — ${ping.reply.app} ${ping.reply.version}`}
        {ping.kind === 'error' && `IPC failed: ${ping.message}`}
      </p>

      <p className="shell__status" data-status={chainState}>
        {log.kind === 'pending' && 'verifying the event log…'}
        {log.kind === 'ok' &&
          `${String(log.summary.count)} event${log.summary.count === 1 ? '' : 's'} · chain ${
            log.summary.chain.ok
              ? `verified to seq ${String(log.summary.head?.seq ?? 0)}`
              : `BROKEN (${String(log.summary.chain.failures.length)} failure${log.summary.chain.failures.length === 1 ? '' : 's'})`
          } · ${log.summary.driver} ${log.summary.journalMode} · schema v${String(log.summary.schemaVersion)}`}
        {log.kind === 'error' && `event log unavailable: ${log.message}`}
      </p>

      <footer className="shell__footer">
        {versions
          ? `Electron ${versions.electron} · Chromium ${versions.chrome} · Node ${versions.node}`
          : 'preload bridge unavailable'}
      </footer>
    </main>
  );
}

import { useEffect, useState, type ReactElement } from 'react';
import { createIpcClient, type IpcResponse } from '@sheep/ipc';
import logoUrl from '@resources/sheep.png';
import { APP_NAME, APP_TAGLINE } from '@shared/product';

type PingState =
  | { kind: 'pending' }
  | { kind: 'ok'; reply: IpcResponse<'sheep:ping'> & { roundTripMs: number } }
  | { kind: 'error'; message: string };

export function App(): ReactElement {
  const versions = window.sheep?.versions;
  const [ping, setPing] = useState<PingState>({ kind: 'pending' });

  useEffect(() => {
    const bridge = window.sheep;
    if (!bridge) {
      setPing({ kind: 'error', message: 'preload bridge unavailable' });
      return;
    }

    let cancelled = false;
    const client = createIpcClient({
      invoke: (channel, payload) => bridge.invoke(channel, payload),
    });

    client
      .ping()
      .then((reply) => {
        if (!cancelled) setPing({ kind: 'ok', reply });
      })
      .catch((error: unknown) => {
        if (!cancelled) setPing({ kind: 'error', message: String(error) });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="shell" data-sheep-ready="true" data-sheep-ping={ping.kind}>
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
          `main process replied in ${ping.reply.roundTripMs} ms — ${ping.reply.app} ${ping.reply.version}`}
        {ping.kind === 'error' && `IPC failed: ${ping.message}`}
      </p>
      <footer className="shell__footer">
        {versions
          ? `Electron ${versions.electron} · Chromium ${versions.chrome} · Node ${versions.node}`
          : 'preload bridge unavailable'}
      </footer>
    </main>
  );
}

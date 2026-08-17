import { useCallback, useEffect, useMemo, useState } from 'react';
import { createIpcClient, type IpcClient } from '@sheep/ipc';
import { DEFAULT_PANE, isPaneId, type PaneId } from '@shared/panes';

/**
 * The typed IPC client, or nothing.
 *
 * `undefined` is a real state, not a defect to be papered over: it means the
 * preload bridge is missing, and a renderer that cannot talk to the main process
 * should say so rather than render an empty app that looks fine.
 */
export function useIpcClient(): IpcClient | undefined {
  return useMemo(() => {
    const bridge = window.sheep;
    if (!bridge) return undefined;
    return createIpcClient({ invoke: (channel, payload) => bridge.invoke(channel, payload) });
  }, []);
}

/**
 * Hash routing.
 *
 * A hash rather than a history API, because the renderer is loaded from a
 * `file://` URL in a packaged build, where path-based routing has no server to
 * fall back on. An unrecognised hash normalises to the first pane instead of
 * rendering nothing.
 */
export function useRoute(): { paneId: PaneId; navigate: (id: PaneId) => void } {
  const [paneId, setPaneId] = useState<PaneId>(() => readHash());

  useEffect(() => {
    const onHashChange = (): void => {
      setPaneId(readHash());
    };
    window.addEventListener('hashchange', onHashChange);
    // Normalise whatever we opened with, so the address always names the pane.
    if (window.location.hash !== `#/${readHash()}`) window.location.hash = `#/${readHash()}`;
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  const navigate = useCallback((id: PaneId) => {
    window.location.hash = `#/${id}`;
  }, []);

  return { paneId, navigate };
}

function readHash(): PaneId {
  const raw = window.location.hash.replace(/^#\/?/, '').trim();
  return isPaneId(raw) ? raw : DEFAULT_PANE;
}

/** Tracks the OS-level preference, so `system` means something live. */
export function useSystemPrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => {
      setPrefersDark(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);

  return prefersDark;
}

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { assertKnownChannel, assertKnownEventChannel } from '@sheep/ipc/channels';
import type { SheepBridge } from '../shared/bridge';

/**
 * The only surface the renderer sees. The renderer is sandboxed and has no
 * Node access; everything it can do arrives through this object.
 *
 * The allowlist check here is the second line of defence — the typed client in
 * the renderer checks first, and the main process refuses unknown channels
 * regardless — but it is the one that survives a compromised renderer bundle.
 */
const sheep: SheepBridge = {
  versions: {
    electron: process.versions['electron'] ?? 'unknown',
    chrome: process.versions['chrome'] ?? 'unknown',
    node: process.versions['node'] ?? 'unknown',
  },
  invoke(channel: string, payload: unknown): Promise<unknown> {
    assertKnownChannel(channel);
    return ipcRenderer.invoke(channel, payload);
  },

  subscribe(channel: string, listener: (payload: unknown) => void): () => void {
    assertKnownEventChannel(channel);

    // The Electron event object is dropped rather than forwarded: it carries a
    // `sender` with methods, and handing the renderer a live handle on the
    // main process through the context bridge would defeat the point of having
    // one.
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
      listener(payload);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('sheep', sheep);

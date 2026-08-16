import { contextBridge } from 'electron';

/**
 * The only surface the renderer sees. The renderer is sandboxed and has no
 * Node access; everything it can do arrives through this object.
 */
const sheep = {
  versions: {
    electron: process.versions['electron'] ?? 'unknown',
    chrome: process.versions['chrome'] ?? 'unknown',
    node: process.versions['node'] ?? 'unknown',
  },
} as const;

export type SheepBridge = typeof sheep;

contextBridge.exposeInMainWorld('sheep', sheep);

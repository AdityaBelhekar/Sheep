/// <reference types="vite/client" />

import type { SheepBridge } from '../../preload';

declare global {
  interface Window {
    /** Injected by the preload script; absent if the bridge failed to load. */
    sheep?: SheepBridge;
  }
}

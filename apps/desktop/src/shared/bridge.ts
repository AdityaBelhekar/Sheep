/**
 * The shape the preload script exposes on `window.sheep`.
 *
 * Declared here rather than in the preload module so the renderer can type
 * against it without pulling Node types across the process boundary.
 */
export interface SheepBridge {
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
  /**
   * Sends a request on an allowlisted channel. Throws synchronously for any
   * channel that is not on the allowlist.
   */
  invoke(channel: string, payload: unknown): Promise<unknown>;
}

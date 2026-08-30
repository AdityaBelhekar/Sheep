import type { BrowserWindow } from 'electron';
import type { StreamEvent } from '@sheep/ipc';

/**
 * Sends one run's events to the renderer.
 *
 * A class rather than a bare `send`, because a run outlives the call that
 * started it: the window can close, be reloaded or be destroyed while a
 * provider is still streaming, and every send has to survive that. Phase 21
 * replaces the body of `push` with a batcher; the shape is here first so
 * nothing above it has to change when it does.
 */
export class StreamPublisher {
  readonly #window: BrowserWindow;
  #closed = false;

  constructor(window: BrowserWindow) {
    this.#window = window;
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(event: StreamEvent): void {
    if (this.#closed) return;
    this.#send(event);
  }

  close(): void {
    this.#closed = true;
  }

  #send(event: StreamEvent): void {
    // A destroyed window is the normal end of a run the user walked away from,
    // not an error: the answer is still being recorded, there is simply nobody
    // watching it arrive.
    if (this.#window.isDestroyed()) return;
    this.#window.webContents.send('sheep:stream-event', event);
  }
}

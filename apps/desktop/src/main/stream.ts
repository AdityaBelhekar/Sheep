import type { BrowserWindow } from 'electron';
import type { StreamEvent } from '@sheep/ipc';

/**
 * Delta batching, between the gateway and the renderer.
 *
 * A provider emits text a few characters at a time; a 600-word answer is
 * several hundred deltas, and six models answering at once is several thousand.
 * Sent one by one those become several thousand IPC messages and several
 * thousand React renders, which is how a UI stutters while doing nothing hard.
 *
 * So text is accumulated and flushed on a frame boundary. Three rules make that
 * safe rather than merely faster:
 *
 * - **Order within a run is never disturbed.** Each run has its own queue and
 *   only adjacent deltas of the same kind merge, so `text, reasoning, text`
 *   stays three entries. Runs are independent, so their order relative to each
 *   other is not a promise anything relies on.
 * - **Nothing is ever dropped.** Backpressure flushes early rather than
 *   discarding: a delta the user paid for is not a frame budget's to throw away.
 * - **`start`, `end` and `error` flush immediately.** They are rare, they carry
 *   no text to coalesce, and a delayed `end` is a spinner that keeps spinning
 *   after the answer has arrived.
 */

/** ~30fps. Below a frame the renderer cannot show the difference anyway. */
export const FRAME_MS = 33;

/** Flush early rather than hold more than this. Bytes, not deltas. */
export const MAX_PENDING_CHARS = 32_768;

export interface StreamBatcherOptions {
  readonly frameMs?: number;
  readonly maxPendingChars?: number;
  /** Injectable timers, so a test is not at the mercy of wall time. */
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

type Coalescible = Extract<StreamEvent, { kind: 'text' | 'reasoning' }>;

function isCoalescible(event: StreamEvent): event is Coalescible {
  return event.kind === 'text' || event.kind === 'reasoning';
}

export class StreamBatcher {
  readonly #sink: (event: StreamEvent) => void;
  readonly #frameMs: number;
  readonly #maxPendingChars: number;
  readonly #schedule: (fn: () => void, ms: number) => unknown;
  readonly #cancel: (handle: unknown) => void;

  /** One queue per run, in the order runs first spoke. */
  readonly #queues = new Map<string, StreamEvent[]>();
  #pendingChars = 0;
  #timer: unknown = null;
  #closed = false;

  constructor(sink: (event: StreamEvent) => void, options: StreamBatcherOptions = {}) {
    this.#sink = sink;
    this.#frameMs = options.frameMs ?? FRAME_MS;
    this.#maxPendingChars = options.maxPendingChars ?? MAX_PENDING_CHARS;
    this.#schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.#cancel =
      options.cancel ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** How much text is waiting for the next frame. For tests and diagnostics. */
  get pendingChars(): number {
    return this.#pendingChars;
  }

  push(event: StreamEvent): void {
    if (this.#closed) return;

    const queue = this.#queues.get(event.runId) ?? [];
    if (!this.#queues.has(event.runId)) this.#queues.set(event.runId, queue);

    if (isCoalescible(event)) {
      const last = queue[queue.length - 1];
      if (last && isCoalescible(last) && last.kind === event.kind) {
        queue[queue.length - 1] = { ...last, text: last.text + event.text };
      } else {
        queue.push(event);
      }
      this.#pendingChars += event.text.length;

      // Backpressure: hand it over now rather than hold an unbounded buffer.
      if (this.#pendingChars >= this.#maxPendingChars) this.flush();
      else this.#arm();
      return;
    }

    // Queued first so it cannot overtake this run's pending text, then flushed:
    // an `end` that arrived before the last words did would be a lie.
    queue.push(event);
    this.flush();
  }

  /** Sends everything queued, now. */
  flush(): void {
    this.#disarm();
    if (this.#queues.size === 0) return;

    const queues = [...this.#queues.values()];
    this.#queues.clear();
    this.#pendingChars = 0;

    for (const queue of queues) {
      for (const event of queue) this.#sink(event);
    }
  }

  /**
   * Flushes and stops accepting.
   *
   * Flushing on close is the difference between a cancelled run whose last
   * words reached the screen and one that appears to have said less than it
   * did — and the recorded message will contain them either way, so a UI that
   * disagreed with the log would be the visible bug.
   */
  close(): void {
    if (this.#closed) return;
    this.flush();
    this.#closed = true;
  }

  #arm(): void {
    if (this.#timer !== null) return;
    this.#timer = this.#schedule(() => {
      this.#timer = null;
      this.flush();
    }, this.#frameMs);
  }

  #disarm(): void {
    if (this.#timer === null) return;
    this.#cancel(this.#timer);
    this.#timer = null;
  }
}

/** One batcher per window, so concurrent runs share a frame rather than race. */
const hubs = new WeakMap<BrowserWindow, StreamBatcher>();

function hubFor(window: BrowserWindow): StreamBatcher {
  const existing = hubs.get(window);
  if (existing && !existing.closed) return existing;

  const batcher = new StreamBatcher((event) => {
    // A destroyed window is the normal end of a run the user walked away from,
    // not an error: the answer is still being recorded, there is simply nobody
    // watching it arrive.
    if (window.isDestroyed()) return;
    window.webContents.send('sheep:stream-event', event);
  });
  hubs.set(window, batcher);
  return batcher;
}

/**
 * One run's view of its window's batcher.
 *
 * A handle rather than the batcher itself, because a run must not be able to
 * close a shared thing it does not own — five other streams may still be using
 * it. Closing a publisher flushes; it does not shut anyone else down.
 */
export class StreamPublisher {
  readonly #batcher: StreamBatcher;
  #closed = false;

  constructor(window: BrowserWindow) {
    this.#batcher = hubFor(window);
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(event: StreamEvent): void {
    if (this.#closed) return;
    this.#batcher.push(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#batcher.flush();
  }
}

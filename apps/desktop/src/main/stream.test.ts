import type { StreamEvent } from '@sheep/ipc';
import { describe, expect, it } from 'vitest';
import { StreamBatcher } from './stream';

const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const PARTICIPANT = '44444444-4444-4444-8444-444444444444';
const MESSAGE = '55555555-5555-4555-8555-555555555555';

function startOf(runId: string): StreamEvent {
  return {
    runId,
    kind: 'start',
    sessionId: SESSION,
    participantId: PARTICIPANT,
    messageId: MESSAGE,
    model: { vendorId: 'ollama', modelId: 'sheep-smoke:1b' },
  };
}

function endOf(runId: string): StreamEvent {
  return {
    runId,
    kind: 'end',
    messageId: MESSAGE,
    finish: 'stop',
    inputTokens: 4,
    outputTokens: 8,
    costUsd: 0,
    partial: false,
  };
}

/** A batcher whose frame boundary is a function call rather than a timer. */
function harness(options: { maxPendingChars?: number } = {}): {
  batcher: StreamBatcher;
  sent: StreamEvent[];
  /** Runs whatever the batcher scheduled, as a frame boundary would. */
  frame(): void;
  scheduled: number;
} {
  const sent: StreamEvent[] = [];
  let pending: (() => void) | null = null;
  let scheduled = 0;

  const batcher = new StreamBatcher(
    (event) => {
      sent.push(event);
    },
    {
      ...(options.maxPendingChars === undefined
        ? {}
        : { maxPendingChars: options.maxPendingChars }),
      schedule: (fn) => {
        scheduled += 1;
        pending = fn;
        return scheduled;
      },
      cancel: () => {
        pending = null;
      },
    },
  );

  return {
    batcher,
    sent,
    frame() {
      const fn = pending;
      pending = null;
      fn?.();
    },
    get scheduled() {
      return scheduled;
    },
  };
}

/** Text of one run's events, in the order they were sent. */
function textsFor(sent: readonly StreamEvent[], runId: string): string[] {
  return sent
    .filter((event) => event.runId === runId && event.kind === 'text')
    .map((event) => (event.kind === 'text' ? event.text : ''));
}

describe('StreamBatcher', () => {
  it('coalesces a frame of text into one event', () => {
    const h = harness();
    h.batcher.push(startOf(RUN_A));
    for (const word of ['a ', 'few ', 'small ', 'deltas']) {
      h.batcher.push({ runId: RUN_A, kind: 'text', text: word });
    }
    // Nothing but `start` has gone out yet: the text is waiting for the frame.
    expect(h.sent).toHaveLength(1);

    h.frame();
    expect(textsFor(h.sent, RUN_A)).toEqual(['a few small deltas']);
  });

  it('arms one timer per frame, not one per delta', () => {
    const h = harness();
    for (let index = 0; index < 50; index += 1) {
      h.batcher.push({ runId: RUN_A, kind: 'text', text: 'x' });
    }
    expect(h.scheduled).toBe(1);
    h.frame();
    expect(h.sent).toHaveLength(1);
  });

  /**
   * The one ordering promise: within a run, nothing overtakes anything. Thinking
   * and answering must not be interleaved into each other by a merge.
   */
  it('never merges across kinds', () => {
    const h = harness();
    h.batcher.push({ runId: RUN_A, kind: 'text', text: 'one' });
    h.batcher.push({ runId: RUN_A, kind: 'reasoning', text: 'hmm' });
    h.batcher.push({ runId: RUN_A, kind: 'text', text: 'two' });
    h.frame();

    expect(h.sent.map((event) => [event.kind, 'text' in event ? event.text : ''])).toEqual([
      ['text', 'one'],
      ['reasoning', 'hmm'],
      ['text', 'two'],
    ]);
  });

  it('keeps two runs apart while sharing a frame', () => {
    const h = harness();
    h.batcher.push({ runId: RUN_A, kind: 'text', text: 'A1 ' });
    h.batcher.push({ runId: RUN_B, kind: 'text', text: 'B1 ' });
    h.batcher.push({ runId: RUN_A, kind: 'text', text: 'A2' });
    h.batcher.push({ runId: RUN_B, kind: 'text', text: 'B2' });
    h.frame();

    expect(textsFor(h.sent, RUN_A)).toEqual(['A1 A2']);
    expect(textsFor(h.sent, RUN_B)).toEqual(['B1 B2']);
    // Two runs, two sends — not four, and not one shared jumble.
    expect(h.sent).toHaveLength(2);
  });

  it('collapses six concurrent streams into one send each per frame', () => {
    const h = harness();
    const runs = Array.from(
      { length: 6 },
      (_unused, index) => `${String(index)}0000000-0000-4000-8000-000000000000`,
    );

    // 6 runs × 40 deltas: the load the stage gate names.
    for (let round = 0; round < 40; round += 1) {
      for (const runId of runs) h.batcher.push({ runId, kind: 'text', text: 'tok ' });
    }
    h.frame();

    expect(h.sent).toHaveLength(6);
    for (const runId of runs) {
      expect(textsFor(h.sent, runId)).toEqual(['tok '.repeat(40)]);
    }
  });

  it('flushes start, end and error the moment they arrive', () => {
    const h = harness();
    h.batcher.push(startOf(RUN_A));
    expect(h.sent).toHaveLength(1);

    h.batcher.push({ runId: RUN_A, kind: 'text', text: 'the last words' });
    h.batcher.push(endOf(RUN_A));

    // The text goes with it: an `end` that overtook the answer would be a lie.
    expect(h.sent.map((event) => event.kind)).toEqual(['start', 'text', 'end']);
  });

  it('flushes early rather than holding an unbounded buffer', () => {
    const h = harness({ maxPendingChars: 16 });
    h.batcher.push({ runId: RUN_A, kind: 'text', text: 'x'.repeat(10) });
    expect(h.sent).toHaveLength(0);

    h.batcher.push({ runId: RUN_A, kind: 'text', text: 'y'.repeat(10) });
    expect(textsFor(h.sent, RUN_A)).toEqual([`${'x'.repeat(10)}${'y'.repeat(10)}`]);
    expect(h.batcher.pendingChars).toBe(0);
  });

  /** Backpressure flushes; it never discards. Every character is accounted for. */
  it('loses nothing under load', () => {
    const h = harness({ maxPendingChars: 8 });
    let expected = '';
    for (let index = 0; index < 200; index += 1) {
      const text = `${String(index % 10)}`;
      expected += text;
      h.batcher.push({ runId: RUN_A, kind: 'text', text });
    }
    h.frame();
    expect(textsFor(h.sent, RUN_A).join('')).toBe(expected);
  });

  it('flushes what it is holding when it closes', () => {
    const h = harness();
    h.batcher.push({ runId: RUN_A, kind: 'text', text: 'half a sentence' });
    h.batcher.close();

    expect(textsFor(h.sent, RUN_A)).toEqual(['half a sentence']);
    expect(h.batcher.closed).toBe(true);
  });

  it('accepts nothing once closed', () => {
    const h = harness();
    h.batcher.close();
    h.batcher.push({ runId: RUN_A, kind: 'text', text: 'too late' });
    h.frame();
    expect(h.sent).toEqual([]);
  });

  it('does nothing on an empty flush', () => {
    const h = harness();
    h.batcher.flush();
    expect(h.sent).toEqual([]);
  });
});

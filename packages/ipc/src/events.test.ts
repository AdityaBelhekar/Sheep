import { describe, expect, it, vi } from 'vitest';
import {
  IPC_EVENT_CHANNELS,
  assertKnownEventChannel,
  isKnownChannel,
  isKnownEventChannel,
} from './channels';
import { createIpcClient, type IpcTransport } from './client';
import { UnknownChannelError } from './errors';
import { IPC_EVENT_CONTRACTS, eventContractFor, type StreamEvent } from './events';

const RUN = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const PARTICIPANT = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';

const start: StreamEvent = {
  runId: RUN,
  kind: 'start',
  sessionId: SESSION,
  participantId: PARTICIPANT,
  messageId: MESSAGE,
  model: { vendorId: 'anthropic', modelId: 'claude-opus-5' },
};

/** A transport that hands back the listener, so a test can drive the channel. */
function fakeTransport(): {
  transport: IpcTransport;
  emit(channel: string, payload: unknown): void;
  listeners: number;
} {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();

  return {
    transport: {
      invoke: () => Promise.resolve({}),
      subscribe(channel, listener) {
        const current = listeners.get(channel) ?? [];
        listeners.set(channel, [...current, listener]);
        return () => {
          listeners.set(
            channel,
            (listeners.get(channel) ?? []).filter((l) => l !== listener),
          );
        };
      },
    },
    emit(channel, payload) {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
    get listeners() {
      return [...listeners.values()].reduce((total, list) => total + list.length, 0);
    },
  };
}

describe('the event allowlist', () => {
  it('has a contract for every event channel and no more', () => {
    expect(Object.keys(IPC_EVENT_CONTRACTS).sort()).toEqual([...IPC_EVENT_CHANNELS].sort());
  });

  /**
   * The two lists run in opposite directions. Merging them would let the
   * renderer `invoke` a channel only main is supposed to speak on.
   */
  it('shares no channel with the request/response allowlist', () => {
    for (const channel of IPC_EVENT_CHANNELS) {
      expect(isKnownEventChannel(channel)).toBe(true);
      expect(isKnownChannel(channel)).toBe(false);
    }
  });

  it('refuses a channel that is not on it', () => {
    expect(() => {
      assertKnownEventChannel('sheep:not-an-event');
    }).toThrow(UnknownChannelError);
  });
});

describe('streamEventSchema', () => {
  it('round-trips every kind', () => {
    const events: StreamEvent[] = [
      start,
      { runId: RUN, kind: 'text', text: 'hello' },
      { runId: RUN, kind: 'reasoning', text: 'thinking' },
      {
        runId: RUN,
        kind: 'end',
        messageId: MESSAGE,
        finish: 'stop',
        inputTokens: 10,
        outputTokens: 4,
        costUsd: 0.0001,
        partial: false,
      },
      {
        runId: RUN,
        kind: 'error',
        messageId: MESSAGE,
        message: 'boom',
        code: 'GATEWAY_PROVIDER_ERROR',
      },
    ];

    for (const event of events) {
      expect(eventContractFor('sheep:stream-event').parse(event)).toEqual(event);
    }
  });

  it('insists every event names its run, so six streams stay routable', () => {
    const parsed = eventContractFor('sheep:stream-event').safeParse({
      kind: 'text',
      text: 'orphan',
    });
    expect(parsed.success).toBe(false);
  });

  /** Null means "no price on file", which is not the same as free. */
  it('lets an end event say the cost is unknown', () => {
    const parsed = eventContractFor('sheep:stream-event').parse({
      runId: RUN,
      kind: 'end',
      messageId: MESSAGE,
      finish: 'cancelled',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      partial: true,
    });
    expect(parsed).toMatchObject({ costUsd: null, partial: true });
  });
});

describe('client.on', () => {
  it('delivers a valid event and stops on unsubscribe', () => {
    const fake = fakeTransport();
    const client = createIpcClient(fake.transport);
    const seen: StreamEvent[] = [];

    const off = client.on('sheep:stream-event', (event) => {
      seen.push(event);
    });
    fake.emit('sheep:stream-event', start);
    expect(seen).toEqual([start]);

    off();
    expect(fake.listeners).toBe(0);
    fake.emit('sheep:stream-event', start);
    expect(seen).toHaveLength(1);
  });

  /**
   * An event has no caller to reject it, so the client is the only place a
   * malformed one can be refused — and dropping it silently would hide a
   * contract break, so the caller is told.
   */
  it('drops a payload that fails its schema and says so', () => {
    const fake = fakeTransport();
    const client = createIpcClient(fake.transport);
    const listener = vi.fn();
    const onInvalid = vi.fn();

    client.on('sheep:stream-event', listener, { onInvalid });
    fake.emit('sheep:stream-event', { runId: RUN, kind: 'text' });

    expect(listener).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenCalledTimes(1);
  });

  it('refuses to subscribe to a channel that is not on the allowlist', () => {
    const client = createIpcClient(fakeTransport().transport);
    expect(() => {
      // @ts-expect-error — the point of the test is the runtime guard.
      client.on('sheep:ping', () => undefined);
    }).toThrow(UnknownChannelError);
  });

  it('is inert on a transport that cannot carry events', () => {
    const client = createIpcClient({ invoke: () => Promise.resolve({}) });
    const off = client.on('sheep:stream-event', () => undefined);
    expect(typeof off).toBe('function');
    expect(() => {
      off();
    }).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { assertKnownChannel, IPC_CHANNELS, isKnownChannel } from './channels';
import { IPC_CONTRACTS } from './contracts';
import { UnknownChannelError } from './errors';

describe('channel allowlist', () => {
  it('has a contract for every channel, and no contract without a channel', () => {
    expect(Object.keys(IPC_CONTRACTS).sort()).toEqual([...IPC_CHANNELS].sort());
  });

  it('contains no duplicates', () => {
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length);
  });

  it('recognises registered channels', () => {
    for (const channel of IPC_CHANNELS) {
      expect(isKnownChannel(channel)).toBe(true);
      expect(() => assertKnownChannel(channel)).not.toThrow();
    }
  });

  it('rejects anything else', () => {
    for (const channel of ['sheep:nope', '', 'ping', '__proto__', 'toString']) {
      expect(isKnownChannel(channel)).toBe(false);
      expect(() => assertKnownChannel(channel)).toThrow(UnknownChannelError);
    }
  });

  it('reports the offending channel on the error', () => {
    try {
      assertKnownChannel('sheep:not-a-channel');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownChannelError);
      expect((error as UnknownChannelError).channel).toBe('sheep:not-a-channel');
      expect((error as UnknownChannelError).code).toBe('IPC_UNKNOWN_CHANNEL');
    }
  });
});

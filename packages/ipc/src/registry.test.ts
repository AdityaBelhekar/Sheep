import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from './channels';
import {
  DuplicateHandlerError,
  IpcValidationError,
  NoHandlerError,
  UnknownChannelError,
} from './errors';
import { IpcRegistry } from './registry';

function pingRegistry(): IpcRegistry {
  return new IpcRegistry().register('sheep:ping', (request) => ({
    pong: true as const,
    app: 'Sheep',
    version: '0.0.0',
    receivedAt: request.sentAt + 1,
    elapsedMs: 1,
  }));
}

describe('IpcRegistry', () => {
  it('dispatches a valid request to its handler', async () => {
    const reply = await pingRegistry().dispatch('sheep:ping', { sentAt: 1_000 });
    expect(reply).toEqual({
      pong: true,
      app: 'Sheep',
      version: '0.0.0',
      receivedAt: 1_001,
      elapsedMs: 1,
    });
  });

  it('passes the call context through to the handler', async () => {
    const handler = vi.fn(() => ({
      pong: true as const,
      app: 'Sheep',
      version: '0.0.0',
      receivedAt: 2,
      elapsedMs: 0,
    }));
    const registry = new IpcRegistry().register('sheep:ping', handler);

    await registry.dispatch('sheep:ping', { sentAt: 2 }, { senderId: 42 });

    expect(handler).toHaveBeenCalledWith({ sentAt: 2 }, { senderId: 42 });
  });

  it('refuses an unregistered channel', async () => {
    await expect(pingRegistry().dispatch('sheep:not-a-channel', {})).rejects.toBeInstanceOf(
      UnknownChannelError,
    );
  });

  it('refuses a known channel with no handler', async () => {
    await expect(new IpcRegistry().dispatch('sheep:ping', { sentAt: 0 })).rejects.toBeInstanceOf(
      NoHandlerError,
    );
  });

  it('refuses to register the same channel twice', () => {
    const registry = pingRegistry();
    expect(() =>
      registry.register('sheep:ping', () => {
        throw new Error('never runs');
      }),
    ).toThrow(DuplicateHandlerError);
  });

  it('rejects a request that fails its contract, without calling the handler', async () => {
    const handler = vi.fn();
    const registry = new IpcRegistry().register('sheep:ping', handler);

    await expect(registry.dispatch('sheep:ping', { sentAt: -1 })).rejects.toBeInstanceOf(
      IpcValidationError,
    );
    await expect(registry.dispatch('sheep:ping', { sentAt: 'soon' })).rejects.toBeInstanceOf(
      IpcValidationError,
    );
    await expect(registry.dispatch('sheep:ping', undefined)).rejects.toBeInstanceOf(
      IpcValidationError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a handler reply that fails its contract', async () => {
    const registry = new IpcRegistry().register(
      'sheep:ping',
      () => ({ pong: true, app: 'Sheep' }) as never,
    );

    const error = await registry.dispatch('sheep:ping', { sentAt: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcValidationError);
    expect((error as IpcValidationError).direction).toBe('response');
    expect((error as IpcValidationError).code).toBe('IPC_INVALID_RESPONSE');
    expect((error as IpcValidationError).issues.join(' ')).toContain('version');
  });

  it('strips properties the contract does not declare', async () => {
    const reply = (await pingRegistry().dispatch('sheep:ping', {
      sentAt: 5,
      injected: 'ignore me',
    })) as Record<string, unknown>;

    expect(reply['injected']).toBeUndefined();
  });

  it('tracks which channels are wired up', () => {
    expect(new IpcRegistry().registeredChannels()).toEqual([]);
    expect(new IpcRegistry().missingChannels()).toEqual([...IPC_CHANNELS]);

    const partial = pingRegistry();
    expect(partial.registeredChannels()).toEqual(['sheep:ping']);
    expect(partial.missingChannels()).toEqual(
      IPC_CHANNELS.filter((channel) => channel !== 'sheep:ping'),
    );
    expect(partial.has('sheep:ping')).toBe(true);
  });

  it('awaits async handlers', async () => {
    const registry = new IpcRegistry().register('sheep:ping', async (request) => {
      await Promise.resolve();
      return {
        pong: true as const,
        app: 'Sheep',
        version: '0.0.0',
        receivedAt: request.sentAt,
        elapsedMs: 0,
      };
    });

    await expect(registry.dispatch('sheep:ping', { sentAt: 7 })).resolves.toMatchObject({
      receivedAt: 7,
    });
  });
});

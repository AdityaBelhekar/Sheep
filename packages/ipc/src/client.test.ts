import { describe, expect, it, vi } from 'vitest';
import { createIpcClient, type IpcTransport } from './client';
import { IpcValidationError, UnknownChannelError } from './errors';
import { IpcRegistry } from './registry';

/** A transport that talks to a real registry, i.e. the full round trip. */
function loopbackTransport(registry: IpcRegistry): IpcTransport {
  return {
    invoke: (channel, payload) => registry.dispatch(channel, payload, { senderId: 1 }),
  };
}

function mainSide(): IpcRegistry {
  return new IpcRegistry().register('sheep:ping', (request) => ({
    pong: true as const,
    app: 'Sheep',
    version: '1.2.3',
    receivedAt: request.sentAt + 4,
    elapsedMs: 4,
  }));
}

describe('createIpcClient', () => {
  it('round-trips ping through the registry and validates the reply', async () => {
    const clock = vi.fn<() => number>().mockReturnValueOnce(1_000).mockReturnValueOnce(1_009);
    const client = createIpcClient(loopbackTransport(mainSide()), { now: clock });

    const reply = await client.ping();

    expect(reply).toEqual({
      pong: true,
      app: 'Sheep',
      version: '1.2.3',
      receivedAt: 1_004,
      elapsedMs: 4,
      roundTripMs: 9,
    });
  });

  it('refuses an unregistered channel before touching the transport', async () => {
    const transport: IpcTransport = { invoke: vi.fn() };
    const client = createIpcClient(transport);

    await expect(
      // @ts-expect-error — the channel is not in the contract map.
      client.invoke('sheep:not-a-channel', {}),
    ).rejects.toBeInstanceOf(UnknownChannelError);
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it('refuses to send a request that fails its contract', async () => {
    const transport: IpcTransport = { invoke: vi.fn() };
    const client = createIpcClient(transport);

    await expect(
      client.invoke('sheep:ping', { sentAt: 1.5 } as { sentAt: number }),
    ).rejects.toBeInstanceOf(IpcValidationError);
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it('rejects a reply that fails its contract', async () => {
    const client = createIpcClient({
      invoke: async () => ({
        pong: false,
        app: 'Sheep',
        version: '1',
        receivedAt: 0,
        elapsedMs: 0,
      }),
    });

    const error = await client.invoke('sheep:ping', { sentAt: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcValidationError);
    expect((error as IpcValidationError).direction).toBe('response');
  });

  it('propagates a rejection from the main side unchanged', async () => {
    const client = createIpcClient({
      invoke: () => Promise.reject(new Error('handler exploded')),
    });

    await expect(client.invoke('sheep:ping', { sentAt: 0 })).rejects.toThrow('handler exploded');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { pairedTransports, RpcClosedError, RpcPeer, RpcTimeoutError } from './rpc';

describe('RpcPeer', () => {
  it('carries calls in both directions', async () => {
    const [left, right] = pairedTransports();
    const main = new RpcPeer(left, { handlers: { record: (params) => ({ echoed: params }) } });
    const child = new RpcPeer(right, { handlers: { run: () => ({ ran: true }) } });

    await expect(main.call('run')).resolves.toEqual({ ran: true });
    await expect(child.call('record', { n: 1 })).resolves.toEqual({ echoed: { n: 1 } });

    main.close();
    child.close();
  });

  it('turns a handler failure into a rejection carrying the reason', async () => {
    const [left, right] = pairedTransports();
    const main = new RpcPeer(left);
    const child = new RpcPeer(right, {
      handlers: {
        boom: () => {
          throw new Error('the store is closed');
        },
      },
    });

    await expect(main.call('boom')).rejects.toThrow('the store is closed');
    main.close();
    child.close();
  });

  it('refuses an unknown method rather than hanging', async () => {
    const [left, right] = pairedTransports();
    const main = new RpcPeer(left);
    const child = new RpcPeer(right);

    await expect(main.call('nope')).rejects.toThrow('unknown orchestrator method: nope');
    main.close();
    child.close();
  });

  it('rejects everything in flight when the peer closes', async () => {
    const [left, right] = pairedTransports();
    const main = new RpcPeer(left);
    // Deliberately never answered: this is the crashed-child case.
    const child = new RpcPeer(right, { handlers: { wait: () => new Promise(() => undefined) } });

    const pending = main.call('wait');
    main.close('the orchestrator exited');
    await expect(pending).rejects.toBeInstanceOf(RpcClosedError);
    await expect(main.call('wait')).rejects.toBeInstanceOf(RpcClosedError);
    child.close();
  });

  it('times out an unanswered call', async () => {
    vi.useFakeTimers();
    try {
      const [left, right] = pairedTransports();
      const main = new RpcPeer(left, { timeoutMs: 50 });
      const child = new RpcPeer(right, { handlers: { wait: () => new Promise(() => undefined) } });

      const pending = main.call('wait');
      const assertion = expect(pending).rejects.toBeInstanceOf(RpcTimeoutError);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      main.close();
      child.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers notifications without expecting a reply', async () => {
    const [left, right] = pairedTransports();
    const seen: unknown[] = [];
    const main = new RpcPeer(left);
    const child = new RpcPeer(right, {
      handlers: {
        progress: (params) => {
          seen.push(params);
        },
      },
    });

    main.notify('progress', { kind: 'phase-opened' });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(seen).toEqual([{ kind: 'phase-opened' }]);
    main.close();
    child.close();
  });
});

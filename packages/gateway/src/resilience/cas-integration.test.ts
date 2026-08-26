import { openSheepStore } from '@sheep/store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectDeltas, type Delta } from '../delta';
import { ProviderError } from '../errors';
import { MockAdapter, type MockScript } from '../mock';
import type { NormalizedRequest } from '../request';
import { replayDeltas, type ExchangeRecord } from './recorder';
import { withResilience } from './resilient-adapter';

/**
 * The recorder against the real content-addressed store.
 *
 * The unit tests use a `BlobPut` in memory, which proves the logic and not the
 * assumption underneath it — that Phase 7's `BlobStore` satisfies the interface
 * without an adapter in between. This is the test that would fail if that ever
 * stopped being true.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sheep-gateway-cas-'));
});

afterEach(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows holds the SQLite file briefly after close; a leftover temp
    // directory is not worth failing a test over.
  }
});

describe('exchange recording against the real CAS', () => {
  it('survives a 429 and replays the exchange from disk', async () => {
    const store = openSheepStore({ dataDir });
    const records: ExchangeRecord[] = [];
    const waits: number[] = [];

    const inner = new MockAdapter({
      respond: (_request, callIndex): MockScript =>
        callIndex === 0
          ? {
              throwAfter: 0,
              error: new ProviderError('mock', 429, 'slow down', { retryAfterMs: 1_500 }),
            }
          : { text: 'Rayleigh scattering.', chunkSize: 5 },
    });

    const adapter = withResilience(inner, {
      blobs: store.blobs,
      onExchange: (record) => records.push(record),
      retry: { maxAttempts: 3 },
      sleep: async (ms) => {
        waits.push(ms);
        await Promise.resolve();
      },
    });

    const request: NormalizedRequest = {
      modelId: 'mock-1',
      system: 'Be terse.',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'Why is the sky blue?' }] }],
      maxOutputTokens: 128,
    };

    const live: Delta[] = [];
    for await (const delta of adapter.stream(request)) live.push(delta);

    expect(waits).toEqual([1_500]);
    const record = records[0];
    expect(record).toMatchObject({ attempts: 2, partial: false });

    // Both halves are really on disk, addressed by their own hashes.
    expect(store.blobs.has(record?.requestHash ?? '')).toBe(true);
    expect(store.blobs.has(record?.transcriptHash ?? '')).toBe(true);

    // Replay: same deltas, same text, no adapter involved.
    const replayed = await collectDeltas(
      replayDeltas(store.blobs.readText(record?.transcriptHash ?? '')),
    );
    expect(replayed.text).toBe('Rayleigh scattering.');
    expect(replayed.usage).toEqual((await collectDeltas(toStream(live))).usage);

    const storedRequest = JSON.parse(store.blobs.readText(record?.requestHash ?? '')) as {
      request: NormalizedRequest;
      wire?: unknown;
    };
    expect(storedRequest.request.system).toBe('Be terse.');

    store.db.close();
  });

  it('stores nothing new when the same exchange happens twice', async () => {
    const store = openSheepStore({ dataDir });
    const records: ExchangeRecord[] = [];
    const adapter = withResilience(new MockAdapter({ respond: { text: 'same' } }), {
      blobs: store.blobs,
      onExchange: (record) => records.push(record),
    });

    const request: NormalizedRequest = {
      modelId: 'mock-1',
      system: null,
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'twice' }] }],
      maxOutputTokens: 64,
    };

    await collectDeltas(adapter.stream(request));
    const before = store.blobs.count();
    await collectDeltas(adapter.stream(request));

    // Same request, same transcript, same two addresses — and no new bytes.
    expect(records[0]?.requestHash).toBe(records[1]?.requestHash);
    expect(records[0]?.transcriptHash).toBe(records[1]?.transcriptHash);
    expect(store.blobs.count()).toBe(before);

    store.db.close();
  });
});

async function* toStream(deltas: readonly Delta[]): AsyncGenerator<Delta, void, undefined> {
  for (const delta of deltas) yield delta;
}

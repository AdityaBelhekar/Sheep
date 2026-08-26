import { describe, expect, it } from 'vitest';
import { collectDeltas, type Delta } from '../delta';
import { CircuitOpenError, ProviderError, RateLimitedError, TransportError } from '../errors';
import { MockAdapter, type MockScript } from '../mock';
import { AdapterRegistry } from '../registry';
import type { NormalizedRequest } from '../request';
import { computeBackoffMs, isRetryable, retryDelayMs } from './backoff';
import { CircuitBreaker } from './circuit-breaker';
import {
  canonicalJson,
  ExchangeRecorder,
  memoryBlobStore,
  replayTranscript,
  type ExchangeRecord,
} from './recorder';
import { withResilience } from './resilient-adapter';
import { TokenBucket } from './token-bucket';

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    modelId: 'mock-1',
    system: null,
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Why is the sky blue?' }] }],
    maxOutputTokens: 256,
    ...overrides,
  };
}

/** A clock and a sleep that moves it, so no test waits in real time. */
function fakeClock(start = 1_000_000) {
  let current = start;
  const waits: number[] = [];
  return {
    now: () => current,
    date: () => new Date(current),
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      current += ms;
      await Promise.resolve();
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function rateLimited(retryAfterMs?: number): ProviderError {
  return new ProviderError('mock', 429, 'rate limit exceeded', {
    providerType: 'rate_limit_error',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** Fails the first `failures` attempts with 429, then answers properly. */
function flakyAdapter(failures: number, error: () => Error = () => rateLimited()): MockAdapter {
  return new MockAdapter({
    respond: (_request, callIndex): MockScript =>
      callIndex < failures
        ? { throwAfter: 0, error: error() }
        : { text: 'Rayleigh scattering.', chunkSize: 6 },
  });
}

describe('TokenBucket', () => {
  it('spends, refills over time, and says how long a caller must wait', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: clock.now });

    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    expect(bucket.msUntilAvailable()).toBe(1000);

    clock.advance(1000);
    expect(bucket.tryTake()).toBe(true);
    // Refill never climbs past capacity, however long it idles.
    clock.advance(60_000);
    expect(bucket.tokens).toBe(2);
  });

  it('refunds a token when the call never left', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0, now: clock.now });

    expect(bucket.tryTake()).toBe(true);
    bucket.refund();
    expect(bucket.tryTake()).toBe(true);
  });
});

describe('backoff', () => {
  it('grows exponentially, jitters fully, and stops at the ceiling', () => {
    const options = { baseMs: 100, maxMs: 1000, random: () => 1 };
    expect(computeBackoffMs(1, options)).toBe(100);
    expect(computeBackoffMs(2, options)).toBe(200);
    expect(computeBackoffMs(3, options)).toBe(400);
    expect(computeBackoffMs(10, options)).toBe(1000);
    // Full jitter: the wait is uniform in [0, ceiling], not ceiling ± a little.
    expect(computeBackoffMs(3, { ...options, random: () => 0 })).toBe(0);
    expect(computeBackoffMs(3, { ...options, random: () => 0.5 })).toBe(200);
  });

  it('prefers the provider’s own retry-after to anything computed', () => {
    const options = { baseMs: 100, maxMs: 1000, random: () => 1 };
    expect(retryDelayMs(rateLimited(7_000), 1, options)).toBe(7_000);
    expect(retryDelayMs(rateLimited(), 1, options)).toBe(100);
  });

  it('retries what is worth retrying and nothing else', () => {
    expect(isRetryable(rateLimited())).toBe(true);
    expect(isRetryable(new TransportError('mock', 'ECONNRESET'))).toBe(true);
    expect(isRetryable(new ProviderError('mock', 400, 'bad request'))).toBe(false);
    expect(isRetryable(new Error('something else'))).toBe(false);
  });
});

describe('CircuitBreaker', () => {
  it('opens on repeated failure, probes once, and closes on success', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker('mock', {
      failureThreshold: 3,
      resetTimeoutMs: 10_000,
      now: clock.now,
    });

    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.state).toBe('closed');
    breaker.onFailure();
    expect(breaker.state).toBe('open');
    expect(() => {
      breaker.assertAllowed();
    }).toThrow(CircuitOpenError);

    clock.advance(10_000);
    expect(breaker.state).toBe('half-open');
    breaker.assertAllowed();
    // Only one probe gets through while the verdict is unknown.
    expect(() => {
      breaker.assertAllowed();
    }).toThrow(CircuitOpenError);

    breaker.onSuccess();
    expect(breaker.state).toBe('closed');
  });

  it('re-opens immediately when the probe fails too', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker('mock', {
      failureThreshold: 2,
      resetTimeoutMs: 5_000,
      now: clock.now,
    });

    breaker.onFailure();
    breaker.onFailure();
    clock.advance(5_000);
    breaker.assertAllowed();
    breaker.onFailure();

    expect(breaker.state).toBe('open');
  });

  it('forgets old failures once a call succeeds', () => {
    const breaker = new CircuitBreaker('mock', { failureThreshold: 3 });
    breaker.onFailure();
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.state).toBe('closed');
  });
});

describe('withResilience', () => {
  it('survives a 429-injecting provider and replays the exchange from CAS', async () => {
    const clock = fakeClock();
    const blobs = memoryBlobStore();
    const records: ExchangeRecord[] = [];
    const inner = flakyAdapter(2, () => rateLimited(2_000));

    const adapter = withResilience(inner, {
      blobs,
      onExchange: (record) => records.push(record),
      retry: { maxAttempts: 4, baseMs: 100, maxMs: 1_000, random: () => 1 },
      sleep: clock.sleep,
      now: clock.date,
    });

    const live: Delta[] = [];
    for await (const delta of adapter.stream(request())) live.push(delta);

    const response = await collectDeltas(toStream(live));
    expect(response.text).toBe('Rayleigh scattering.');
    // Two refusals, honoured at the provider's own pace, then the real answer.
    expect(clock.waits).toEqual([2_000, 2_000]);
    expect(inner.requests).toHaveLength(3);

    const record = records[0];
    expect(record).toMatchObject({ attempts: 3, partial: false, stopReason: 'stop' });
    expect(record?.usage?.outputTokens).toBeGreaterThan(0);

    // The exchange replays byte for byte from the store, with no provider.
    const transcript = blobs.read(record?.transcriptHash ?? '');
    expect(replayTranscript(transcript ?? '')).toEqual(live);

    const stored = JSON.parse(blobs.read(record?.requestHash ?? '') ?? '{}') as {
      request: NormalizedRequest;
      adapterId: string;
    };
    expect(stored.adapterId).toBe('mock');
    expect(stored.request.messages[0]?.content[0]).toEqual({
      kind: 'text',
      text: 'Why is the sky blue?',
    });
  });

  it('keeps the partial transcript when a stream dies mid-answer', async () => {
    const clock = fakeClock();
    const blobs = memoryBlobStore();
    const records: ExchangeRecord[] = [];
    const boom = new TransportError('mock', 'ECONNRESET');
    const inner = new MockAdapter({
      // Retryable, but not retried: the caller has already seen these tokens.
      respond: { text: 'half an answer here', chunkSize: 4, throwAfter: 3, error: boom },
    });

    const adapter = withResilience(inner, {
      blobs,
      onExchange: (record) => records.push(record),
      retry: { maxAttempts: 4, baseMs: 1, random: () => 1 },
      sleep: clock.sleep,
      now: clock.date,
    });

    const seen: Delta[] = [];
    await expect(
      (async () => {
        for await (const delta of adapter.stream(request())) seen.push(delta);
      })(),
    ).rejects.toThrow(boom);

    expect(seen).toHaveLength(3);
    expect(inner.requests).toHaveLength(1);

    const record = records[0];
    expect(record).toMatchObject({ partial: true, attempts: 1, deltaCount: 3 });
    expect(record?.error?.name).toBe('TransportError');
    // The tokens were paid for, so what arrived is kept.
    expect(replayTranscript(blobs.read(record?.transcriptHash ?? '') ?? '')).toEqual(seen);
  });

  it('gives up on a failure that is not worth retrying', async () => {
    const clock = fakeClock();
    const inner = flakyAdapter(1, () => new ProviderError('mock', 400, 'bad request'));
    const adapter = withResilience(inner, { sleep: clock.sleep, now: clock.date });

    await expect(collectDeltas(adapter.stream(request()))).rejects.toThrow(/400/);
    expect(inner.requests).toHaveLength(1);
    expect(clock.waits).toEqual([]);
  });

  it('opens the circuit and then refuses without calling the provider', async () => {
    const clock = fakeClock();
    const inner = flakyAdapter(Number.POSITIVE_INFINITY);
    const adapter = withResilience(inner, {
      retry: { maxAttempts: 2, baseMs: 1, random: () => 1 },
      circuit: { failureThreshold: 2, resetTimeoutMs: 10_000, now: clock.now },
      sleep: clock.sleep,
      now: clock.date,
    });

    // Two attempts inside one call are enough to trip a threshold of two.
    await expect(collectDeltas(adapter.stream(request()))).rejects.toThrow(ProviderError);
    expect(adapter.breaker.state).toBe('open');

    const callsBefore = inner.requests.length;
    await expect(collectDeltas(adapter.stream(request()))).rejects.toThrow(CircuitOpenError);
    // Refused locally: the provider was left alone entirely.
    expect(inner.requests).toHaveLength(callsBefore);

    clock.advance(10_000);
    expect(adapter.breaker.state).toBe('half-open');
  });

  it('waits for a rate-limit slot, and refuses when the wait is absurd', async () => {
    const clock = fakeClock();
    const adapter = withResilience(new MockAdapter(), {
      rateLimit: { capacity: 1, refillPerSecond: 1, now: clock.now },
      retry: { maxRateLimitWaitMs: 5_000 },
      sleep: clock.sleep,
      now: clock.date,
    });

    await collectDeltas(adapter.stream(request()));
    expect(clock.waits).toEqual([]);

    // Bucket empty: the second call waits a second rather than taking a 429.
    await collectDeltas(adapter.stream(request()));
    expect(clock.waits).toEqual([1_000]);

    const slow = withResilience(new MockAdapter(), {
      rateLimit: { capacity: 1, refillPerSecond: 0.001, initialTokens: 0, now: clock.now },
      retry: { maxRateLimitWaitMs: 5_000 },
      sleep: clock.sleep,
      now: clock.date,
    });
    await expect(collectDeltas(slow.stream(request()))).rejects.toThrow(RateLimitedError);
  });

  it('stores one blob for two identical requests', () => {
    const blobs = memoryBlobStore();
    const recorder = new ExchangeRecorder(blobs);

    const first = recorder.putRequest({
      adapterId: 'mock',
      vendorId: 'mock',
      request: request(),
    });
    const second = recorder.putRequest({
      adapterId: 'mock',
      vendorId: 'mock',
      request: request(),
    });

    expect(first).toBe(second);
    expect(blobs.size).toBe(1);
  });

  it('hashes the same request the same way whatever order it was built in', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('is still an adapter, so the registry treats it like any other', async () => {
    const clock = fakeClock();
    const registry = new AdapterRegistry().register(
      withResilience(flakyAdapter(1), {
        retry: { maxAttempts: 2, baseMs: 1, random: () => 1 },
        sleep: clock.sleep,
        now: clock.date,
      }),
    );

    const response = await collectDeltas(registry.stream('mock', request()));
    expect(response.text).toBe('Rayleigh scattering.');
  });
});

async function* toStream(deltas: readonly Delta[]): AsyncGenerator<Delta, void, undefined> {
  for (const delta of deltas) yield delta;
}

import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from './adapters/anthropic';
import { OllamaAdapter } from './adapters/local';
import { OpenAiCompatibleAdapter } from './adapters/openai';
import { BudgetGovernor } from './budget/governor';
import { withBudget } from './budget/budgeted-adapter';
import { collectDeltas } from './delta';
import { BudgetExceededError } from './errors';
import { fakeFetch, jsonLinesResponse, jsonResponse, sseResponse } from './http/test-support';
import { AdapterRegistry } from './registry';
import type { NormalizedRequest } from './request';
import { memoryBlobStore, replayTranscript, type ExchangeRecord } from './resilience/recorder';
import { withResilience } from './resilience/resilient-adapter';

/**
 * The Stage 2 gate, as one test.
 *
 * "A cloud model, a local model, and a custom endpoint all stream, with spend
 * tracked and capped." Each phase has its own tests; this one exists because
 * the gate is about the parts working *together* — one registry, one governor,
 * one recorder, three very different providers underneath.
 */

function ask(modelId: string, maxOutputTokens = 1_000): NormalizedRequest {
  return {
    modelId,
    system: 'Answer in one line.',
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Why is the sky blue?' }] }],
    maxOutputTokens,
  };
}

/** Anthropic: SSE, cache-aware usage, list-priced. */
function cloudFetch() {
  return fakeFetch(() =>
    sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5-20260101","usage":{"input_tokens":1000}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Rayleigh scattering."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2000}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]),
  );
}

/** Ollama: newline-delimited JSON, free. */
function localFetch() {
  return fakeFetch((call) =>
    call.url.endsWith('/api/chat')
      ? jsonLinesResponse([
          { model: 'llama3.1:8b', message: { content: 'Shorter wavelengths scatter more.' } },
          { done: true, done_reason: 'stop', prompt_eval_count: 900, eval_count: 400 },
        ])
      : jsonResponse({ models: [{ name: 'llama3.1:8b', model: 'llama3.1:8b' }] }),
  );
}

/** A self-hosted OpenAI-compatible endpoint: no preset, priced by the user. */
function customFetch() {
  return fakeFetch((call) =>
    call.url.endsWith('/models')
      ? jsonResponse({ data: [{ id: 'house-model-v2' }] })
      : sseResponse([
          'data: {"id":"c1","model":"house-model-v2","choices":[{"delta":{"content":"Because of scattering."}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":800,"completion_tokens":600}}\n\n',
          'data: [DONE]\n\n',
        ]),
  );
}

describe('Stage 2 gate', () => {
  it('streams a cloud model, a local model and a custom endpoint, and tracks the spend', async () => {
    const blobs = memoryBlobStore();
    const records: ExchangeRecord[] = [];
    const governor = new BudgetGovernor().defineScope('session', { capUsd: 1 });
    // The house model publishes no prices, so the user supplied them.
    governor.pricing.set('acme', 'house-model-v2', {
      inputPerMTokUsd: 0.5,
      outputPerMTokUsd: 1.5,
    });

    const wrap = (adapter: Parameters<typeof withResilience>[0]) =>
      withBudget(
        withResilience(adapter, {
          blobs,
          onExchange: (record) => records.push(record),
          rateLimit: { capacity: 10, refillPerSecond: 10 },
        }),
        { governor, scope: 'session' },
      );

    const registry = new AdapterRegistry()
      .register(wrap(new AnthropicAdapter({ apiKey: 'sk-test', fetch: cloudFetch().fetch })))
      .register(wrap(new OllamaAdapter({ fetch: localFetch().fetch })))
      .register(
        wrap(
          new OpenAiCompatibleAdapter({
            adapterId: 'acme',
            vendorId: 'acme',
            baseUrl: 'https://models.acme.internal/v1',
            apiKey: 'house-key',
            fetch: customFetch().fetch,
          }),
        ),
      );

    const cloud = await collectDeltas(registry.stream('anthropic', ask('claude-opus-5')));
    const local = await collectDeltas(registry.stream('ollama', ask('llama3.1:8b')));
    const custom = await collectDeltas(registry.stream('acme', ask('house-model-v2')));

    expect(cloud.text).toBe('Rayleigh scattering.');
    expect(local.text).toBe('Shorter wavelengths scatter more.');
    expect(custom.text).toBe('Because of scattering.');

    // Three vendors, which is what P1 will need to hold a critic apart.
    expect([cloud.model.vendorId, local.model.vendorId, custom.model.vendorId]).toEqual([
      'anthropic',
      'ollama',
      'acme',
    ]);

    // Cloud: 1k in at $5/M plus 2k out at $25/M = $0.055. Local: free.
    // House model, at the user's own rates: $0.0004 + $0.0009 = $0.0013.
    expect(governor.spentUsd('session')).toBe(0.0563);
    expect(governor.state('session').calls).toBe(3);
    expect(governor.state('session').remainingUsd).toBe(0.9437);

    // Every exchange is in the store and replays without a provider.
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.partial).toBe(false);
      expect(replayTranscript(blobs.read(record.transcriptHash) ?? '').at(-1)?.kind).toBe('end');
    }
  });

  it('caps the session and resumes it on confirmation', async () => {
    const governor = new BudgetGovernor().defineScope('session', { capUsd: 0.06 });
    const adapter = withBudget(
      withResilience(new AnthropicAdapter({ apiKey: 'sk-test', fetch: cloudFetch().fetch })),
      { governor, scope: 'session' },
    );

    // First call fits: $0.005 of input plus a $0.025 output allowance.
    await collectDeltas(adapter.stream(ask('claude-opus-5')));
    expect(governor.status).toBe('running');

    // A 100k-token allowance would cost $2.50 to authorise: refused outright.
    await expect(collectDeltas(adapter.stream(ask('claude-opus-5', 100_000)))).rejects.toThrow(
      BudgetExceededError,
    );
    expect(governor.status).toBe('halted');
    const spentAtHalt = governor.spentUsd('session');

    // Nothing was spent on the refused call.
    await expect(collectDeltas(adapter.stream(ask('claude-opus-5')))).rejects.toThrow(
      BudgetExceededError,
    );
    expect(governor.spentUsd('session')).toBe(spentAtHalt);

    governor.resume({ raiseCapUsd: 10 });
    const resumed = await collectDeltas(adapter.stream(ask('claude-opus-5')));
    expect(resumed.text).toBe('Rayleigh scattering.');
    expect(governor.spentUsd('session')).toBeGreaterThan(spentAtHalt);
  });
});

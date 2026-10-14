import { describe, expect, it } from 'vitest';
import { priceUsageFor } from '../cost';
import { collectDeltas, type Delta } from '../delta';
import { CredentialError, ProviderError } from '../errors';
import { errorResponse, fakeFetch, jsonResponse, sseResponse } from '../http/test-support';
import { AdapterRegistry } from '../registry';
import type { NormalizedRequest } from '../request';
import { AnthropicAdapter, ANTHROPIC_MODELS } from './anthropic';

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    modelId: 'claude-opus-5',
    system: null,
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Why is the sky blue?' }] }],
    maxOutputTokens: 1024,
    ...overrides,
  };
}

/** One completion, exactly as the Messages API frames it. */
const COMPLETION = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","model":"claude-opus-5-20260101","usage":{"input_tokens":21,"cache_read_input_tokens":100}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  ': keep-alive\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Rayleigh "}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta"',
  ',"text":"scattering."}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

async function drain(stream: AsyncIterable<Delta>): Promise<Delta[]> {
  const deltas: Delta[] = [];
  for await (const delta of stream) deltas.push(delta);
  return deltas;
}

describe('AnthropicAdapter', () => {
  it('streams a completion, including a payload split across chunks', async () => {
    const http = fakeFetch([sseResponse(COMPLETION)]);
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', fetch: http.fetch });

    const response = await collectDeltas(adapter.stream(request()));

    expect(response.text).toBe('Rayleigh scattering.');
    expect(response.stopReason).toBe('stop');
    expect(response.providerRequestId).toBe('msg_01');
    // The alias asked for, and the snapshot that answered.
    expect(response.model).toEqual({
      vendorId: 'anthropic',
      modelId: 'claude-opus-5',
      version: 'claude-opus-5-20260101',
    });
    expect(response.usage).toEqual({ inputTokens: 21, outputTokens: 9, cachedInputTokens: 100 });
  });

  it('sends the pinned version header and the key from the provider', async () => {
    const http = fakeFetch([sseResponse(COMPLETION)]);
    let asked = 0;
    const adapter = new AnthropicAdapter({
      apiKey: () => {
        asked += 1;
        return 'sk-from-keychain';
      },
      fetch: http.fetch,
    });

    await drain(adapter.stream(request({ system: 'Be terse.', stopSequences: ['\n\n'] })));

    const call = http.calls[0];
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call?.headers['anthropic-version']).toBe('2023-06-01');
    expect(call?.headers['x-api-key']).toBe('sk-from-keychain');
    expect(call?.body).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 1024,
      stream: true,
      system: 'Be terse.',
      stop_sequences: ['\n\n'],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Why is the sky blue?' }] }],
    });
    // Resolved per call, so a rotated key takes effect immediately.
    expect(asked).toBe(1);
  });

  it('normalises tool calls into fragments with a stable call id', async () => {
    const http = fakeFetch([
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_02","usage":{"input_tokens":40}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"search"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"sky\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    ]);
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', fetch: http.fetch });

    const response = await collectDeltas(
      adapter.stream(
        request({
          tools: [{ name: 'search', description: 'Search', parameters: { type: 'object' } }],
          toolChoice: 'required',
        }),
      ),
    );

    expect(response.stopReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([
      { callId: 'toolu_1', name: 'search', argumentsJson: '{"q":"sky"}' },
    ]);
    // "You must call something" is `any` on this vendor, not `required`.
    expect(http.calls[0]?.body).toMatchObject({
      tool_choice: { type: 'any' },
      tools: [{ name: 'search', description: 'Search', input_schema: { type: 'object' } }],
    });
  });

  it('streams thinking as reasoning, kept apart from the answer', async () => {
    const http = fakeFetch([
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":5}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"weighing it up"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Blue."}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    ]);
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-test',
      fetch: http.fetch,
      thinking: 'adaptive',
      effort: 'high',
    });

    const response = await collectDeltas(adapter.stream(request()));

    expect(response.reasoning).toBe('weighing it up');
    expect(response.text).toBe('Blue.');
    expect(http.calls[0]?.body).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    });
  });

  it('turns a mid-stream overloaded error into a retryable failure', async () => {
    const http = fakeFetch([
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":5}}}\n\n',
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ]),
    ]);
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', fetch: http.fetch });

    await expect(drain(adapter.stream(request()))).rejects.toMatchObject({
      name: 'ProviderError',
      status: 529,
      retryable: true,
    });
  });

  it('surfaces an HTTP failure with its retry-after', async () => {
    const http = fakeFetch([
      errorResponse(
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
        { 'retry-after': '30' },
      ),
    ]);
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', fetch: http.fetch });

    const failure = drain(adapter.stream(request()));
    await expect(failure).rejects.toThrow(ProviderError);
    await expect(failure).rejects.toMatchObject({
      status: 429,
      retryable: true,
      retryAfterMs: 30_000,
      providerType: 'rate_limit_error',
    });
  });

  it('asks for the prefix to be cached only when the request says it will be sent again', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test' });
    const request = {
      modelId: 'claude-opus-5-5',
      system: 'You are one of several models.',
      messages: [{ role: 'user' as const, content: [{ kind: 'text' as const, text: 'Hello' }] }],
      maxOutputTokens: 64,
    };
    expect(adapter.toWire(request)['cache_control']).toBeUndefined();
    expect(adapter.toWire({ ...request, cachePrefix: true })['cache_control']).toEqual({
      type: 'ephemeral',
    });
  });

  it('refuses to send a blank key', async () => {
    const adapter = new AnthropicAdapter({ apiKey: () => '', fetch: fakeFetch([]).fetch });
    await expect(drain(adapter.stream(request()))).rejects.toThrow(CredentialError);
  });

  it('counts input tokens without a max_tokens field', async () => {
    const http = fakeFetch([jsonResponse({ input_tokens: 512 })]);
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', fetch: http.fetch });

    expect(await adapter.countInputTokens(request())).toBe(512);
    expect(http.calls[0]?.url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    expect(http.calls[0]?.body).not.toHaveProperty('max_tokens');
    expect(http.calls[0]?.body).not.toHaveProperty('stream');
  });

  it('publishes a priced catalogue, and merges unpriced models on refresh', async () => {
    const http = fakeFetch([
      jsonResponse({
        data: [
          { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
          { id: 'claude-future-9', display_name: 'Claude Future 9', max_input_tokens: 2_000_000 },
        ],
      }),
    ]);
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', fetch: http.fetch });

    const offline = await adapter.listModels();
    expect(offline).toHaveLength(ANTHROPIC_MODELS.length);
    expect(offline.every((entry) => entry.pricing !== null)).toBe(true);

    const refreshed = await adapter.listModels({ refresh: true });
    const future = refreshed.find((entry) => entry.modelId === 'claude-future-9');
    expect(future?.pricing).toBeNull();
    // The known model keeps its prices rather than being overwritten by the API.
    expect(refreshed.filter((entry) => entry.modelId === 'claude-opus-5')).toHaveLength(1);
  });

  it('prices a completion from its reported usage', async () => {
    const opus = ANTHROPIC_MODELS.find((entry) => entry.modelId === 'claude-opus-5');
    const cost = priceUsageFor(
      opus!,
      { inputTokens: 1_000_000, outputTokens: 200_000, cachedInputTokens: 1_000_000 },
      'measured',
    );
    // $5 input + $5 output + $0.50 cache read.
    expect(cost.costUsd).toBe(10.5);
  });

  it('refuses temperature on a model that rejects it', async () => {
    const http = fakeFetch([sseResponse(COMPLETION)]);
    const registry = new AdapterRegistry().register(
      new AnthropicAdapter({ apiKey: 'sk-test', fetch: http.fetch }),
    );

    await expect(
      drain(registry.stream('anthropic', request({ temperature: 0.5 }))),
    ).rejects.toMatchObject({ name: 'UnsupportedCapabilityError', capabilities: ['temperature'] });
    // Nothing was sent: the refusal happened before the network.
    expect(http.calls).toHaveLength(0);

    await expect(
      drain(
        registry.stream('anthropic', request({ modelId: 'claude-opus-4-6', temperature: 0.5 })),
      ),
    ).resolves.toBeDefined();
  });
});

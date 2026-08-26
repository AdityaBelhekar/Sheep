import { describe, expect, it } from 'vitest';
import { collectDeltas } from '../delta';
import { fakeFetch, jsonResponse, sseResponse } from '../http/test-support';
import { AdapterRegistry } from '../registry';
import type { NormalizedRequest } from '../request';
import { createAzureOpenAiAdapter, createOpenAiAdapter, OpenAiCompatibleAdapter } from './openai';

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    modelId: 'gpt-5',
    system: null,
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Why is the sky blue?' }] }],
    maxOutputTokens: 512,
    ...overrides,
  };
}

function chunks(...rows: unknown[]): string[] {
  return [...rows.map((row) => `data: ${JSON.stringify(row)}\n\n`), 'data: [DONE]\n\n'];
}

const COMPLETION = chunks(
  { id: 'chatcmpl-1', model: 'gpt-5-2026-01-01', choices: [{ delta: { role: 'assistant' } }] },
  { choices: [{ delta: { content: 'Rayleigh ' } }] },
  { choices: [{ delta: { content: 'scattering.' } }, { index: 1 }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  {
    choices: [],
    usage: {
      prompt_tokens: 30,
      completion_tokens: 9,
      prompt_tokens_details: { cached_tokens: 20 },
    },
  },
);

describe('OpenAiCompatibleAdapter', () => {
  it('drives two different providers from config alone', async () => {
    const openai = fakeFetch([sseResponse(COMPLETION)]);
    const groq = fakeFetch([sseResponse(COMPLETION)]);

    const openaiAdapter = createOpenAiAdapter('openai', {
      apiKey: 'sk-openai',
      fetch: openai.fetch,
    });
    const groqAdapter = createOpenAiAdapter('groq', { apiKey: 'gsk-groq', fetch: groq.fetch });

    // Same class, same parser, same normalisation.
    expect(openaiAdapter).toBeInstanceOf(OpenAiCompatibleAdapter);
    expect(groqAdapter).toBeInstanceOf(OpenAiCompatibleAdapter);

    const first = await collectDeltas(openaiAdapter.stream(request()));
    const second = await collectDeltas(groqAdapter.stream(request({ modelId: 'llama-3.3-70b' })));

    expect(first.text).toBe('Rayleigh scattering.');
    expect(second.text).toBe('Rayleigh scattering.');
    expect(first.model.vendorId).toBe('openai');
    expect(second.model.vendorId).toBe('groq');

    expect(openai.calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(groq.calls[0]?.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(openai.calls[0]?.headers['authorization']).toBe('Bearer sk-openai');

    // The only wire difference between them: what the output cap is called.
    expect(openai.calls[0]?.body).toMatchObject({ max_completion_tokens: 512 });
    expect(groq.calls[0]?.body).toMatchObject({ max_tokens: 512 });
  });

  it('subtracts cached tokens out of the prompt count', async () => {
    const http = fakeFetch([sseResponse(COMPLETION)]);
    const adapter = createOpenAiAdapter('openai', { apiKey: 'sk', fetch: http.fetch });

    const response = await collectDeltas(adapter.stream(request()));

    // 30 prompt tokens of which 20 were cached: 10 billed at the full rate.
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 9, cachedInputTokens: 20 });
    expect(response.model.version).toBe('gpt-5-2026-01-01');
    expect(response.providerRequestId).toBe('chatcmpl-1');
  });

  it('closes tool calls the provider never says are finished', async () => {
    const stream = sseResponse(
      chunks(
        { id: 'c', model: 'gpt-5', choices: [{ delta: { role: 'assistant' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_a', function: { name: 'search', arguments: '{"q"' } },
                ],
              },
            },
          ],
        },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"sky"}' } }] } }],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ),
    );
    // The registry describes the model before it streams, so the catalogue
    // call has to be answered too.
    const http = fakeFetch((call) =>
      call.url.endsWith('/models') ? jsonResponse({ data: [{ id: 'gpt-5' }] }) : stream,
    );
    const registry = new AdapterRegistry().register(
      createOpenAiAdapter('openai', { apiKey: 'sk', fetch: http.fetch }),
    );

    // Through the registry: the stream guard is what proves it is well-formed.
    const response = await collectDeltas(registry.stream('openai', request()));

    expect(response.stopReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([
      { callId: 'call_a', name: 'search', argumentsJson: '{"q":"sky"}' },
    ]);
  });

  it('streams reasoning under either name the clones use', async () => {
    const http = fakeFetch([
      sseResponse(
        chunks(
          { id: 'c', model: 'deepseek-reasoner', choices: [{ delta: {} }] },
          { choices: [{ delta: { reasoning_content: 'first ' } }] },
          { choices: [{ delta: { reasoning: 'second' } }] },
          { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
        ),
      ),
    ]);
    const adapter = createOpenAiAdapter('deepseek', { apiKey: 'sk', fetch: http.fetch });

    const response = await collectDeltas(adapter.stream(request({ modelId: 'deepseek-reasoner' })));
    expect(response.reasoning).toBe('first second');
    expect(response.text).toBe('done');
  });

  it('flattens tool results into their own messages, in order', async () => {
    const http = fakeFetch([sseResponse(COMPLETION)]);
    const adapter = createOpenAiAdapter('openai', { apiKey: 'sk', fetch: http.fetch });

    await collectDeltas(
      adapter.stream(
        request({
          system: 'Be terse.',
          messages: [
            { role: 'user', content: [{ kind: 'text', text: 'search for sky' }] },
            {
              role: 'assistant',
              content: [
                {
                  kind: 'tool_use',
                  callId: 'call_a',
                  name: 'search',
                  argumentsJson: '{"q":"sky"}',
                },
              ],
            },
            {
              role: 'user',
              content: [
                { kind: 'tool_result', callId: 'call_a', content: 'blue' },
                { kind: 'text', text: 'now explain' },
              ],
            },
          ],
        }),
      ),
    );

    expect(http.calls[0]?.body).toMatchObject({
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'search for sky' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"sky"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: 'blue' },
        { role: 'user', content: 'now explain' },
      ],
    });
  });

  it('reads OpenRouter prices, and leaves prices unknown everywhere else', async () => {
    const openrouter = fakeFetch([
      jsonResponse({
        data: [
          {
            id: 'anthropic/claude-opus-5',
            name: 'Claude Opus 5',
            context_length: 1_000_000,
            pricing: { prompt: '0.000005', completion: '0.000025' },
          },
        ],
      }),
    ]);
    const priced = await createOpenAiAdapter('openrouter', {
      apiKey: 'sk',
      fetch: openrouter.fetch,
    }).listModels();

    expect(priced[0]).toMatchObject({
      modelId: 'anthropic/claude-opus-5',
      contextWindowTokens: 1_000_000,
      pricing: { inputPerMTokUsd: 5, outputPerMTokUsd: 25 },
    });

    const plain = fakeFetch([jsonResponse({ data: [{ id: 'gpt-5' }] })]);
    const unpriced = await createOpenAiAdapter('openai', {
      apiKey: 'sk',
      fetch: plain.fetch,
    }).listModels();
    // Unknown, not free — Phase 17 refuses to run this under a cap.
    expect(unpriced[0]?.pricing).toBeNull();
  });

  it('takes prices from the connection settings when the provider publishes none', async () => {
    const http = fakeFetch([jsonResponse({ data: [{ id: 'gpt-5' }] })]);
    const adapter = createOpenAiAdapter('openai', {
      apiKey: 'sk',
      fetch: http.fetch,
      modelPricing: { 'gpt-5': { inputPerMTokUsd: 1.25, outputPerMTokUsd: 10 } },
    });

    const models = await adapter.listModels();
    expect(models[0]?.pricing).toEqual({ inputPerMTokUsd: 1.25, outputPerMTokUsd: 10 });
  });

  it('describes a deployment the catalogue never listed', async () => {
    const http = fakeFetch([jsonResponse({ data: [] })]);
    const adapter = createOpenAiAdapter('openai', { apiKey: 'sk', fetch: http.fetch });

    const descriptor = await adapter.describeModel('ft:gpt-5:acme:custom');
    expect(descriptor).toMatchObject({ modelId: 'ft:gpt-5:acme:custom', pricing: null });
  });

  it('reaches Azure by deployment path, api-version and api-key header', async () => {
    const http = fakeFetch([sseResponse(COMPLETION)]);
    const adapter = createAzureOpenAiAdapter({
      endpoint: 'https://sheep.openai.azure.com/',
      apiKey: 'azure-secret',
      apiVersion: '2026-01-01',
      fetch: http.fetch,
    });

    await collectDeltas(adapter.stream(request({ modelId: 'my-deployment' })));

    expect(http.calls[0]?.url).toBe(
      'https://sheep.openai.azure.com/openai/deployments/my-deployment/chat/completions?api-version=2026-01-01',
    );
    expect(http.calls[0]?.headers['api-key']).toBe('azure-secret');
    expect(http.calls[0]?.headers['authorization']).toBeUndefined();
    // Still the same vendor, so P1 will not let it critique OpenAI's own output.
    expect(adapter.vendorId).toBe('openai');
  });

  it('maps a truncated completion to max_tokens', async () => {
    const http = fakeFetch([
      sseResponse(
        chunks(
          { id: 'c', model: 'gpt-5', choices: [{ delta: { content: 'half' } }] },
          { choices: [{ delta: {}, finish_reason: 'length' }] },
        ),
      ),
    ]);
    const adapter = createOpenAiAdapter('openai', { apiKey: 'sk', fetch: http.fetch });

    const response = await collectDeltas(adapter.stream(request()));
    expect(response.stopReason).toBe('max_tokens');
  });
});

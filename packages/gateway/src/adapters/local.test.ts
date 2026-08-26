import { describe, expect, it } from 'vitest';
import { priceUsageFor } from '../cost';
import { collectDeltas } from '../delta';
import { errorResponse, fakeFetch, jsonLinesResponse, jsonResponse } from '../http/test-support';
import { AdapterRegistry } from '../registry';
import type { NormalizedRequest } from '../request';
import {
  createLocalAdapter,
  detectLocalProviders,
  OllamaAdapter,
  probeLocalProvider,
} from './local';

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    modelId: 'llama3.1:8b',
    system: null,
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Why is the sky blue?' }] }],
    maxOutputTokens: 256,
    ...overrides,
  };
}

const TAGS = { models: [{ name: 'llama3.1:8b', model: 'llama3.1:8b' }] };

const COMPLETION = [
  { model: 'llama3.1:8b', message: { role: 'assistant', content: 'Rayleigh ' }, done: false },
  { model: 'llama3.1:8b', message: { role: 'assistant', content: 'scattering.' }, done: false },
  { model: 'llama3.1:8b', done: true, done_reason: 'stop', prompt_eval_count: 18, eval_count: 7 },
];

/** Nothing listening: what `fetch` does when the port is closed. */
function refused(): never {
  throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
    code: 'ECONNREFUSED',
  });
}

describe('OllamaAdapter', () => {
  it('streams newline-delimited JSON as deltas', async () => {
    const http = fakeFetch([jsonLinesResponse(COMPLETION)]);
    const adapter = new OllamaAdapter({ fetch: http.fetch });

    const response = await collectDeltas(adapter.stream(request()));

    expect(response.text).toBe('Rayleigh scattering.');
    expect(response.stopReason).toBe('stop');
    expect(response.usage).toEqual({ inputTokens: 18, outputTokens: 7 });
    expect(http.calls[0]?.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(http.calls[0]?.body).toMatchObject({
      model: 'llama3.1:8b',
      stream: true,
      options: { num_predict: 256 },
    });
  });

  it('prices a local model at zero rather than refusing to price it', async () => {
    const http = fakeFetch([jsonResponse(TAGS), jsonResponse({ model_info: {} })]);
    const adapter = new OllamaAdapter({ fetch: http.fetch });

    const descriptor = await adapter.describeModel('llama3.1:8b');
    expect(descriptor?.local).toBe(true);
    expect(
      priceUsageFor(descriptor!, { inputTokens: 100_000, outputTokens: 50_000 }, 'measured')
        .costUsd,
    ).toBe(0);
  });

  it('takes the real context length from /api/show when it is published', async () => {
    const http = fakeFetch([
      jsonResponse(TAGS),
      jsonResponse({ model_info: { 'llama.context_length': 131_072 } }),
    ]);
    const adapter = new OllamaAdapter({ fetch: http.fetch });

    expect((await adapter.describeModel('llama3.1:8b'))?.contextWindowTokens).toBe(131_072);
  });

  it('keeps the model when an older Ollama has no /api/show', async () => {
    const http = fakeFetch([jsonResponse(TAGS), errorResponse(404, { error: 'not found' })]);
    const adapter = new OllamaAdapter({ fetch: http.fetch });

    expect((await adapter.describeModel('llama3.1:8b'))?.modelId).toBe('llama3.1:8b');
  });

  it('reports a model it does not have as unknown', async () => {
    const http = fakeFetch([jsonResponse(TAGS)]);
    const adapter = new OllamaAdapter({ fetch: http.fetch });

    expect(await adapter.describeModel('mistral:7b')).toBeNull();
  });

  it('normalises tool calls that arrive whole and unlabelled', async () => {
    const http = fakeFetch((call) =>
      call.url.endsWith('/api/chat')
        ? jsonLinesResponse([
            {
              model: 'llama3.1:8b',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ function: { name: 'search', arguments: { q: 'sky' } } }],
              },
            },
            { done: true, done_reason: 'stop', prompt_eval_count: 20, eval_count: 12 },
          ])
        : jsonResponse(TAGS),
    );
    const registry = new AdapterRegistry().register(new OllamaAdapter({ fetch: http.fetch }));

    const response = await collectDeltas(
      registry.stream(
        'ollama',
        request({
          tools: [{ name: 'search', description: 'Search', parameters: { type: 'object' } }],
        }),
      ),
    );

    expect(response.stopReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([
      { callId: 'search_0', name: 'search', argumentsJson: '{"q":"sky"}' },
    ]);
  });

  it('streams a local model’s thinking as reasoning', async () => {
    const http = fakeFetch([
      jsonLinesResponse([
        { model: 'qwen3', message: { thinking: 'hmm ' } },
        { model: 'qwen3', message: { content: 'Blue.' } },
        { done: true, prompt_eval_count: 3, eval_count: 2 },
      ]),
    ]);
    const adapter = new OllamaAdapter({ fetch: http.fetch });

    const response = await collectDeltas(adapter.stream(request({ modelId: 'qwen3' })));
    expect(response.reasoning).toBe('hmm ');
    expect(response.text).toBe('Blue.');
  });
});

describe('local runtimes over the OpenAI dialect', () => {
  it('reaches llama.cpp and LM Studio on their own ports with no key', async () => {
    const llama = fakeFetch([jsonResponse({ data: [{ id: 'qwen2.5-7b-instruct' }] })]);
    const lmstudio = fakeFetch([jsonResponse({ data: [{ id: 'phi-4' }] })]);

    const llamaModels = await createLocalAdapter('llamacpp', { fetch: llama.fetch }).listModels();
    const lmModels = await createLocalAdapter('lmstudio', { fetch: lmstudio.fetch }).listModels();

    expect(llama.calls[0]?.url).toBe('http://127.0.0.1:8080/v1/models');
    expect(lmstudio.calls[0]?.url).toBe('http://127.0.0.1:1234/v1/models');
    // No key was configured, so no authorization header went out.
    expect(llama.calls[0]?.headers['authorization']).toBeUndefined();
    expect(llamaModels[0]).toMatchObject({ modelId: 'qwen2.5-7b-instruct', local: true });
    expect(lmModels[0]).toMatchObject({ modelId: 'phi-4', local: true });
  });
});

describe('autodetect', () => {
  it('finds a running Ollama and lists what it has', async () => {
    const http = fakeFetch((call) =>
      call.url.startsWith('http://127.0.0.1:11434') ? jsonResponse(TAGS) : refused(),
    );

    const found = await detectLocalProviders({ fetch: http.fetch });
    const ollama = found.find((entry) => entry.id === 'ollama');

    expect(ollama).toMatchObject({
      status: 'running',
      displayName: 'Ollama',
      models: ['llama3.1:8b'],
    });
  });

  it('reports a clean absence on a machine with nothing installed', async () => {
    // This machine, today: no local runtime on any of the three ports.
    const http = fakeFetch(() => refused());

    const found = await detectLocalProviders({ fetch: http.fetch });

    expect(found).toHaveLength(3);
    expect(found.every((entry) => entry.status === 'absent')).toBe(true);
    expect(found.every((entry) => entry.models.length === 0)).toBe(true);
    // Absence comes with somewhere to go, not a stack trace.
    expect(found.map((entry) => entry.install)).toEqual([
      'https://ollama.com/download',
      'https://github.com/ggml-org/llama.cpp',
      'https://lmstudio.ai',
    ]);
  });

  it('distinguishes something answering wrongly from nothing being there', async () => {
    const http = fakeFetch([errorResponse(500, { error: 'boom' })]);

    const status = await probeLocalProvider('ollama', { fetch: http.fetch });
    expect(status).toMatchObject({ status: 'unreachable', detail: 'responded 500' });
  });

  it('never rejects, whatever the probe throws', async () => {
    const http = fakeFetch(() => {
      throw new Error('the network stack fell over');
    });

    await expect(detectLocalProviders({ fetch: http.fetch })).resolves.toHaveLength(3);
  });
});

describe('autodetect against this machine', () => {
  it('probes the real ports and answers either way', async () => {
    // No fake fetch: this is the actual check the settings screen runs. On a
    // machine with nothing installed it must still resolve, quickly and
    // cleanly — which is the half of the phase that is easy to leave untested.
    const found = await detectLocalProviders({ timeoutMs: 1_000 });

    expect(found.map((entry) => entry.id)).toEqual(['ollama', 'llamacpp', 'lmstudio']);
    for (const entry of found) {
      expect(['running', 'absent', 'unreachable']).toContain(entry.status);
      if (entry.status === 'running') expect(Array.isArray(entry.models)).toBe(true);
    }
  });
});

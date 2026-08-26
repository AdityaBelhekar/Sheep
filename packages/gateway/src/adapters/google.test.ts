import { describe, expect, it } from 'vitest';
import { memoryTokenStore } from '../auth/oauth';
import { collectDeltas } from '../delta';
import { fakeFetch, jsonResponse, sseResponse } from '../http/test-support';
import { AdapterRegistry } from '../registry';
import type { NormalizedRequest } from '../request';
import {
  createGoogleOAuthAdapter,
  createGoogleOAuthClient,
  GoogleAdapter,
  GOOGLE_AUTHORIZATION_PARAMS,
} from './google';

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    modelId: 'gemini-2.5-pro',
    system: null,
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Why is the sky blue?' }] }],
    maxOutputTokens: 512,
    ...overrides,
  };
}

function chunks(...rows: unknown[]): string[] {
  return rows.map((row) => `data: ${JSON.stringify(row)}\n\n`);
}

const COMPLETION = chunks(
  {
    responseId: 'resp-1',
    modelVersion: 'gemini-2.5-pro-002',
    candidates: [{ content: { parts: [{ text: 'Rayleigh ' }] } }],
  },
  { candidates: [{ content: { parts: [{ text: 'scattering.' }] }, finishReason: 'STOP' }] },
  {
    usageMetadata: {
      promptTokenCount: 30,
      candidatesTokenCount: 9,
      cachedContentTokenCount: 20,
      thoughtsTokenCount: 4,
    },
  },
);

const CATALOGUE = {
  models: [
    {
      name: 'models/gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 65_536,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    },
    {
      name: 'models/text-embedding-004',
      displayName: 'Embedding',
      supportedGenerationMethods: ['embedContent'],
    },
  ],
};

describe('GoogleAdapter', () => {
  it('streams Gemini with an API key in the header, never the URL', async () => {
    const http = fakeFetch([sseResponse(COMPLETION)]);
    const adapter = new GoogleAdapter({
      credentials: { kind: 'apiKey', apiKey: 'AIza-test' },
      fetch: http.fetch,
    });

    const response = await collectDeltas(adapter.stream(request()));

    expect(response.text).toBe('Rayleigh scattering.');
    expect(response.model.version).toBe('gemini-2.5-pro-002');
    expect(response.providerRequestId).toBe('resp-1');
    // Cached tokens come out of the prompt count, reasoning is reported apart.
    expect(response.usage).toEqual({
      inputTokens: 10,
      outputTokens: 9,
      cachedInputTokens: 20,
      reasoningTokens: 4,
    });

    const call = http.calls[0];
    expect(call?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );
    expect(call?.headers['x-goog-api-key']).toBe('AIza-test');
    expect(call?.url).not.toContain('AIza-test');
  });

  it('signs in with Google and streams with no key pasted anywhere', async () => {
    const store = memoryTokenStore();
    const http = fakeFetch((call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({
          access_token: 'ya29.granted',
          refresh_token: '1//refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      return sseResponse(COMPLETION);
    });

    const client = createGoogleOAuthClient({
      clientId: 'sheep-desktop.apps.googleusercontent.com',
      fetch: http.fetch,
    });

    let authorizationUrl: URL | undefined;
    const tokens = await client.signIn({
      timeoutMs: 5_000,
      prompt: 'consent',
      openBrowser: async (url) => {
        authorizationUrl = new URL(url);
        await fetch(
          `${authorizationUrl.searchParams.get('redirect_uri') ?? ''}?code=code&state=${
            authorizationUrl.searchParams.get('state') ?? ''
          }`,
        );
      },
    });
    await store.save(tokens);

    // Offline access is what makes the refresh token exist at all.
    expect(authorizationUrl?.searchParams.get('access_type')).toBe(
      GOOGLE_AUTHORIZATION_PARAMS['access_type'],
    );
    expect(tokens.refreshToken).toBe('1//refresh');

    const adapter = createGoogleOAuthAdapter({ client, store, fetch: http.fetch });
    expect(adapter.authKind).toBe('oauth');

    const response = await collectDeltas(adapter.stream(request()));
    expect(response.text).toBe('Rayleigh scattering.');

    const streamCall = http.calls.at(-1);
    expect(streamCall?.headers['authorization']).toBe('Bearer ya29.granted');
    expect(streamCall?.headers['x-goog-api-key']).toBeUndefined();
  });

  it('sends whole function calls as one fragment under a synthesised id', async () => {
    const http = fakeFetch([
      sseResponse(
        chunks(
          {
            modelVersion: 'gemini-2.5-pro',
            candidates: [
              {
                content: { parts: [{ functionCall: { name: 'search', args: { q: 'sky' } } }] },
                finishReason: 'STOP',
              },
            ],
          },
          { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 } },
        ),
      ),
    ]);
    const adapter = new GoogleAdapter({
      credentials: { kind: 'apiKey', apiKey: 'AIza' },
      fetch: http.fetch,
    });

    const response = await collectDeltas(
      adapter.stream(
        request({
          tools: [{ name: 'search', description: 'Search', parameters: { type: 'object' } }],
          toolChoice: { kind: 'tool', name: 'search' },
        }),
      ),
    );

    expect(response.toolCalls).toEqual([
      { callId: 'search_0', name: 'search', argumentsJson: '{"q":"sky"}' },
    ]);
    expect(http.calls[0]?.body).toMatchObject({
      tools: [{ functionDeclarations: [{ name: 'search', description: 'Search' }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search'] } },
    });
  });

  it('separates thought parts from the answer', async () => {
    const http = fakeFetch([
      sseResponse(
        chunks({
          candidates: [
            {
              content: {
                parts: [{ text: 'consider scattering', thought: true }, { text: 'Blue.' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
        }),
      ),
    ]);
    const adapter = new GoogleAdapter({
      credentials: { kind: 'apiKey', apiKey: 'AIza' },
      fetch: http.fetch,
    });

    const response = await collectDeltas(adapter.stream(request()));
    expect(response.reasoning).toBe('consider scattering');
    expect(response.text).toBe('Blue.');
  });

  it('maps the system prompt, roles and generation config into Gemini shape', async () => {
    const http = fakeFetch([sseResponse(COMPLETION)]);
    const adapter = new GoogleAdapter({
      credentials: { kind: 'apiKey', apiKey: 'AIza' },
      fetch: http.fetch,
    });

    await collectDeltas(
      adapter.stream(
        request({
          system: 'Be terse.',
          temperature: 0.4,
          stopSequences: ['END'],
          messages: [
            { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
            { role: 'assistant', content: [{ kind: 'text', text: 'hello' }] },
          ],
        }),
      ),
    );

    expect(http.calls[0]?.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'Be terse.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        // The assistant is called `model` on this vendor.
        { role: 'model', parts: [{ text: 'hello' }] },
      ],
      generationConfig: { maxOutputTokens: 512, temperature: 0.4, stopSequences: ['END'] },
    });
  });

  it('lists only models that can hold a conversation', async () => {
    const http = fakeFetch([jsonResponse(CATALOGUE)]);
    const adapter = new GoogleAdapter({
      credentials: { kind: 'apiKey', apiKey: 'AIza' },
      fetch: http.fetch,
      modelPricing: { 'gemini-2.5-pro': { inputPerMTokUsd: 1.25, outputPerMTokUsd: 10 } },
    });

    const models = await adapter.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      modelId: 'gemini-2.5-pro',
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 65_536,
      pricing: { inputPerMTokUsd: 1.25, outputPerMTokUsd: 10 },
    });
  });

  it('streams through the registry like any other adapter', async () => {
    const http = fakeFetch((call) =>
      call.url.includes(':streamGenerateContent')
        ? sseResponse(COMPLETION)
        : jsonResponse(CATALOGUE),
    );
    const registry = new AdapterRegistry().register(
      new GoogleAdapter({ credentials: { kind: 'apiKey', apiKey: 'AIza' }, fetch: http.fetch }),
    );

    const response = await collectDeltas(registry.stream('google', request()));
    expect(response.text).toBe('Rayleigh scattering.');
  });
});

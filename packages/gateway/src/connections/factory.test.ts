import { LOCAL_PROVIDER_IDS, OPENAI_PRESET_IDS, type ConnectionConfig } from '@sheep/core';
import { describe, expect, it } from 'vitest';
import { LOCAL_PROVIDERS } from '../adapters/local';
import { OPENAI_COMPATIBLE_PRESETS } from '../adapters/openai';
import { CredentialError, ProviderError, TransportError } from '../errors';
import { errorResponse, fakeFetch, jsonResponse } from '../http/test-support';
import { buildAdapter, checkAdapter, ConnectionConfigError } from './factory';

const secret = 'sk-test-key';

describe('the config vocabulary and the adapter tables agree', () => {
  it('names every OpenAI-dialect preset the gateway can build', () => {
    // `custom` has no table entry by design: it is the escape hatch for
    // anything the table does not name.
    const declared = OPENAI_PRESET_IDS.filter((preset) => preset !== 'custom');
    expect([...declared].sort()).toEqual(Object.keys(OPENAI_COMPATIBLE_PRESETS).sort());
  });

  it('names every local runtime the gateway can probe', () => {
    expect([...LOCAL_PROVIDER_IDS].sort()).toEqual(Object.keys(LOCAL_PROVIDERS).sort());
  });
});

describe('buildAdapter', () => {
  it.each([
    ['anthropic', { kind: 'anthropic' }, 'anthropic'],
    ['a preset endpoint', { kind: 'openai-compatible', preset: 'groq' }, 'groq'],
    [
      'azure',
      { kind: 'azure-openai', endpoint: 'https://x.openai.azure.com', apiVersion: '2024-10-21' },
      'openai',
    ],
    ['google by key', { kind: 'google' }, 'google'],
  ] as [string, ConnectionConfig, string][])(
    'builds %s with the right vendor',
    (_name, config, vendorId) => {
      const adapter = buildAdapter({ adapterId: 'test-1', config, secret });
      expect(adapter.adapterId).toBe('test-1');
      expect(adapter.vendorId).toBe(vendorId);
    },
  );

  it('builds a local runtime with no credential at all', () => {
    const adapter = buildAdapter({
      adapterId: 'ollama-1',
      config: { kind: 'local', provider: 'ollama' },
    });
    expect(adapter.vendorId).toBe('ollama');
  });

  /**
   * Two Ollama servers on one machine is a legitimate setup, and the registry
   * is keyed by adapter id — so a local adapter that named itself after its
   * runtime rather than its connection would make the second one unregistrable.
   */
  it('gives every local connection its own registry key', () => {
    const ids = (['ollama', 'llamacpp', 'lmstudio'] as const).map(
      (provider) =>
        buildAdapter({
          adapterId: `${provider}-abc123`,
          config: { kind: 'local', provider },
        }).adapterId,
    );
    expect(ids).toEqual(['ollama-abc123', 'llamacpp-abc123', 'lmstudio-abc123']);
  });

  it('builds a custom endpoint under the vendor it declares', () => {
    const adapter = buildAdapter({
      adapterId: 'mistral-1',
      config: {
        kind: 'openai-compatible',
        preset: 'custom',
        baseUrl: 'https://api.mistral.ai/v1',
        vendorId: 'mistral',
      },
      secret,
    });
    expect(adapter.vendorId).toBe('mistral');
  });

  it('refuses a custom endpoint that names neither a URL nor a vendor', () => {
    expect(() =>
      buildAdapter({
        adapterId: 'broken-1',
        config: { kind: 'openai-compatible', preset: 'custom' },
        secret,
      }),
    ).toThrow(ConnectionConfigError);
  });

  it('refuses to build a keyed connection with no key', () => {
    expect(() => buildAdapter({ adapterId: 'anthropic-1', config: { kind: 'anthropic' } })).toThrow(
      CredentialError,
    );
  });

  it('refuses to build a sign-in connection that has not signed in', () => {
    expect(() =>
      buildAdapter({
        adapterId: 'google-1',
        config: { kind: 'google-oauth', clientId: '1234.apps.googleusercontent.com' },
      }),
    ).toThrow(CredentialError);
  });

  it('builds a sign-in connection once a token provider exists', () => {
    const adapter = buildAdapter({
      adapterId: 'google-1',
      config: { kind: 'google-oauth', clientId: '1234.apps.googleusercontent.com' },
      accessToken: () => Promise.resolve('ya29.token'),
    });
    expect(adapter.vendorId).toBe('google');
  });

  it('routes the request at the configured base URL', async () => {
    const http = fakeFetch(() => jsonResponse({ data: [{ id: 'llama-3.1-70b' }] }));
    const adapter = buildAdapter({
      adapterId: 'proxy-1',
      config: {
        kind: 'openai-compatible',
        preset: 'custom',
        baseUrl: 'https://proxy.internal/v1',
        vendorId: 'proxy',
      },
      secret,
      fetch: http.fetch,
    });

    await adapter.listModels();
    expect(http.calls[0]?.url.startsWith('https://proxy.internal/v1')).toBe(true);
  });
});

describe('checkAdapter', () => {
  const now = (): Date => new Date('2026-08-30T10:00:00.000Z');

  it('reports a reachable provider and how much it can see', async () => {
    const http = fakeFetch(() => jsonResponse({ data: [{ id: 'a' }, { id: 'b' }] }));
    const adapter = buildAdapter({
      adapterId: 'openai-1',
      config: { kind: 'openai-compatible', preset: 'openai' },
      secret,
      fetch: http.fetch,
    });

    const check = await checkAdapter(adapter, { now });
    expect(check).toEqual({
      health: 'ok',
      detail: '2 models reachable',
      modelCount: 2,
      checkedAt: '2026-08-30T10:00:00.000Z',
    });
  });

  it('calls a rejected key what it is, rather than blaming the network', async () => {
    const http = fakeFetch(() => errorResponse(401, { error: { message: 'invalid api key' } }));
    const adapter = buildAdapter({
      adapterId: 'openai-2',
      config: { kind: 'openai-compatible', preset: 'openai' },
      secret,
      fetch: http.fetch,
    });

    const check = await checkAdapter(adapter, { now });
    expect(check.health).toBe('unauthorized');
    expect(check.modelCount).toBeNull();
  });

  it('reports a server that is failing as unreachable', async () => {
    const http = fakeFetch(() => errorResponse(503, { error: { message: 'down' } }));
    const adapter = buildAdapter({
      adapterId: 'openai-3',
      config: { kind: 'openai-compatible', preset: 'openai' },
      secret,
      fetch: http.fetch,
    });

    expect((await checkAdapter(adapter, { now })).health).toBe('unreachable');
  });

  it('never throws, whatever the adapter does', async () => {
    const exploding = {
      adapterId: 'boom',
      vendorId: 'boom',
      listModels: () => Promise.reject(new Error('kaboom')),
      describeModel: () => Promise.resolve(null),
      // eslint-disable-next-line require-yield
      stream: async function* () {
        throw new Error('not used');
      },
    };

    const check = await checkAdapter(exploding, { now });
    expect(check.health).toBe('unreachable');
    expect(check.detail).toContain('kaboom');
  });

  it('classifies the gateway error types it is given', async () => {
    for (const [error, health] of [
      [new CredentialError('x', 'no key'), 'unauthorized'],
      [new ProviderError('x', 403, 'forbidden'), 'unauthorized'],
      [new ProviderError('x', 500, 'oops'), 'unreachable'],
      [new TransportError('x', 'dns'), 'unreachable'],
      [new ConnectionConfigError(['no base URL']), 'misconfigured'],
    ] as const) {
      const adapter = {
        adapterId: 'x',
        vendorId: 'x',
        listModels: () => Promise.reject(error),
        describeModel: () => Promise.resolve(null),
        // eslint-disable-next-line require-yield
        stream: async function* () {
          throw error;
        },
      };
      expect((await checkAdapter(adapter, { now })).health).toBe(health);
    }
  });
});

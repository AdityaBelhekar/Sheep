import { describe, expect, it } from 'vitest';
import {
  CONNECTION_KINDS,
  adapterPrefixFor,
  connectionConfigIssues,
  connectionConfigSchema,
  connectionSchema,
  credentialKindForConfig,
  requiresSecret,
  usesInteractiveSignIn,
  vendorIdForConfig,
  type ConnectionConfig,
} from './connection';

/** One valid config per kind, so every branch below is exercised. */
const SAMPLES: Record<string, ConnectionConfig> = {
  anthropic: { kind: 'anthropic' },
  'openai-compatible': { kind: 'openai-compatible', preset: 'groq' },
  'azure-openai': {
    kind: 'azure-openai',
    endpoint: 'https://sheep.openai.azure.com',
    apiVersion: '2024-10-21',
  },
  google: { kind: 'google' },
  'google-oauth': { kind: 'google-oauth', clientId: '1234.apps.googleusercontent.com' },
  local: { kind: 'local', provider: 'ollama' },
};

describe('connection config', () => {
  it('has a sample for every declared kind', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...CONNECTION_KINDS].sort());
  });

  it.each(Object.entries(SAMPLES))('parses a %s config', (_kind, config) => {
    expect(connectionConfigSchema.parse(config)).toEqual(config);
  });

  it('rejects an unknown field, so a writer and a reader cannot disagree', () => {
    const parsed = connectionConfigSchema.safeParse({ kind: 'anthropic', apiKey: 'sk-nope' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a base URL that is not http', () => {
    const parsed = connectionConfigSchema.safeParse({
      kind: 'anthropic',
      baseUrl: 'file:///etc/passwd',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('vendorIdForConfig', () => {
  it('reads the vendor from a preset', () => {
    expect(vendorIdForConfig({ kind: 'openai-compatible', preset: 'deepseek' })).toBe('deepseek');
  });

  it('calls Azure OpenAI what it is: OpenAI weights', () => {
    expect(vendorIdForConfig(SAMPLES['azure-openai'] as ConnectionConfig)).toBe('openai');
  });

  it('takes a custom endpoint at its word', () => {
    expect(
      vendorIdForConfig({
        kind: 'openai-compatible',
        preset: 'custom',
        baseUrl: 'https://example.test/v1',
        vendorId: 'mistral',
      }),
    ).toBe('mistral');
  });

  it('treats both Google kinds as the same vendor, because they are', () => {
    expect(vendorIdForConfig(SAMPLES['google'] as ConnectionConfig)).toBe('google');
    expect(vendorIdForConfig(SAMPLES['google-oauth'] as ConnectionConfig)).toBe('google');
  });

  it('names a local runtime as its own vendor', () => {
    expect(vendorIdForConfig({ kind: 'local', provider: 'lmstudio' })).toBe('lmstudio');
  });
});

describe('connectionConfigIssues', () => {
  it('accepts every well-formed sample', () => {
    for (const config of Object.values(SAMPLES)) {
      expect(connectionConfigIssues(config)).toEqual([]);
    }
  });

  it('insists a custom endpoint names its base URL and its vendor', () => {
    const issues = connectionConfigIssues({ kind: 'openai-compatible', preset: 'custom' });
    expect(issues).toHaveLength(2);
    expect(issues.join(' ')).toContain('base URL');
    expect(issues.join(' ')).toContain('vendor id');
  });

  it('is satisfied once a custom endpoint is complete', () => {
    expect(
      connectionConfigIssues({
        kind: 'openai-compatible',
        preset: 'custom',
        baseUrl: 'https://example.test/v1',
        vendorId: 'mistral',
      }),
    ).toEqual([]);
  });
});

describe('credential requirements', () => {
  it('asks for an API key for every pasted-key kind', () => {
    for (const kind of ['anthropic', 'openai-compatible', 'azure-openai', 'google'] as const) {
      const config = SAMPLES[kind] as ConnectionConfig;
      expect(credentialKindForConfig(config)).toBe('api-key');
      expect(requiresSecret(config)).toBe(true);
      expect(usesInteractiveSignIn(config)).toBe(false);
    }
  });

  it('stores a refresh token, not a key, for a sign-in connection', () => {
    const config = SAMPLES['google-oauth'] as ConnectionConfig;
    expect(credentialKindForConfig(config)).toBe('oauth-refresh-token');
    expect(requiresSecret(config)).toBe(true);
    expect(usesInteractiveSignIn(config)).toBe(true);
  });

  it('asks a local runtime for nothing at all', () => {
    const config = SAMPLES['local'] as ConnectionConfig;
    expect(credentialKindForConfig(config)).toBeNull();
    expect(requiresSecret(config)).toBe(false);
  });
});

describe('adapterPrefixFor', () => {
  it('names the provider rather than the shape of its configuration', () => {
    expect(adapterPrefixFor({ kind: 'openai-compatible', preset: 'xai' })).toBe('xai');
    expect(adapterPrefixFor({ kind: 'local', provider: 'llamacpp' })).toBe('llamacpp');
    expect(adapterPrefixFor({ kind: 'anthropic' })).toBe('anthropic');
  });
});

describe('connectionSchema', () => {
  const record = {
    connectionId: '2f9f1c1e-6a3f-4c7a-9f0b-8f5b0b0f1a2b',
    label: 'Anthropic (personal)',
    adapterId: 'anthropic-1a2b3c4d',
    vendorId: 'anthropic',
    config: { kind: 'anthropic' },
    credentialRef: 'sheep.credential.2f9f1c1e-6a3f-4c7a-9f0b-8f5b0b0f1a2b',
    enabled: true,
    health: 'unknown',
    healthDetail: null,
    modelCount: null,
    checkedAt: null,
    createdAt: '2026-08-30T10:00:00.000Z',
    updatedAt: '2026-08-30T10:00:00.000Z',
  };

  it('round-trips a stored connection', () => {
    expect(connectionSchema.parse(record)).toEqual(record);
  });

  it('refuses anything that is not a credential reference', () => {
    const parsed = connectionSchema.safeParse({ ...record, credentialRef: 'sk-ant-not-a-ref' });
    expect(parsed.success).toBe(false);
  });

  it('allows no credential at all, which is what a local runtime has', () => {
    expect(connectionSchema.parse({ ...record, credentialRef: null }).credentialRef).toBeNull();
  });
});

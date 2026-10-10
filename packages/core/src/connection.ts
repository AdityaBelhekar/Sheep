import { z } from 'zod';
import { credentialRefSchema, type CredentialKind } from './credential';
import { vendorIdSchema, type VendorId } from './model';
import { idSchema, slugSchema, timestampSchema, titleSchema } from './primitives';

/**
 * A connection: one configured way of reaching models.
 *
 * A connection is *configuration*, not history — which is why it lives in a
 * table of its own rather than in the event log. The log records what happened
 * in a session; a connection is something the user set up and may rename,
 * repoint or delete afterwards. The two are joined by `ModelRef`, which
 * snapshots the connection id, vendor and model into every message: provenance
 * survives the connection being deleted, and renaming one never rewrites
 * history.
 *
 * A connection also never holds a secret. It holds a `credentialRef` — the
 * handle from Phase 9 — so the rule that keeps keys out of the database keeps
 * them out of this record too.
 */

/** `http://` or `https://`, and nothing else. Not a path, not a bare host. */
export const httpUrlSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^https?:\/\/\S+$/, 'expected an http or https URL');

/**
 * The adapter categories a user can configure.
 *
 * One entry per *shape of configuration*, not per provider: every
 * OpenAI-dialect endpoint is one kind with a preset, because Phase 13 made them
 * one code path, and splitting them here would invent a distinction the gateway
 * does not have.
 */
export const CONNECTION_KINDS = [
  'anthropic',
  'openai-compatible',
  'azure-openai',
  'google',
  'google-oauth',
  'local',
] as const;
export const connectionKindSchema = z.enum(CONNECTION_KINDS);
export type ConnectionKind = z.infer<typeof connectionKindSchema>;

/**
 * Named OpenAI-dialect providers, plus `custom` for anything else.
 *
 * Declared here rather than only in the gateway because it is vocabulary the
 * stored configuration is written in, and a config row outlives any one build's
 * adapter table. A test in `@sheep/gateway` asserts the two lists agree.
 */
export const OPENAI_PRESET_IDS = [
  'openai',
  'groq',
  'together',
  'deepseek',
  'openrouter',
  'xai',
  'ollama-cloud',
  'custom',
] as const;
export const openAiPresetIdSchema = z.enum(OPENAI_PRESET_IDS);
export type OpenAiPresetId = z.infer<typeof openAiPresetIdSchema>;

export const LOCAL_PROVIDER_IDS = ['ollama', 'llamacpp', 'lmstudio'] as const;
export const localProviderIdSchema = z.enum(LOCAL_PROVIDER_IDS);
export type LocalProviderId = z.infer<typeof localProviderIdSchema>;

/**
 * Everything a kind needs to become an adapter, and nothing else. An optional
 * field means "use the provider's default", never "unknown".
 */
export const connectionConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('anthropic'),
    baseUrl: httpUrlSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('openai-compatible'),
    preset: openAiPresetIdSchema,
    /** Required for `custom`; otherwise the preset supplies it. */
    baseUrl: httpUrlSchema.optional(),
    /**
     * Required for `custom`: P1 compares vendors, so a proxy must name one.
     * Read for `ollama-cloud` too, which serves many makers' models under one
     * key: the vendor is whose model this connection is used for.
     */
    vendorId: vendorIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('azure-openai'),
    endpoint: httpUrlSchema,
    apiVersion: z.string().min(1).max(40),
  }),
  z.strictObject({
    kind: z.literal('google'),
    baseUrl: httpUrlSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('google-oauth'),
    /** Public by definition in a native app; PKCE is what protects the exchange. */
    clientId: z.string().min(1).max(400),
  }),
  z.strictObject({
    kind: z.literal('local'),
    provider: localProviderIdSchema,
    baseUrl: httpUrlSchema.optional(),
  }),
]);
export type ConnectionConfig = z.infer<typeof connectionConfigSchema>;

/**
 * Health, as of the last time the connection was tested.
 *
 * `unknown` is the honest state for a connection nobody has tested, and is
 * deliberately not folded into `unreachable`: never having asked is not the
 * same as having asked and been refused. `misconfigured` is a connection whose
 * settings cannot produce an adapter at all — the user's to fix, and not worth
 * a network call to discover.
 */
export const CONNECTION_HEALTH = [
  'unknown',
  'ok',
  'unauthorized',
  'unreachable',
  'misconfigured',
] as const;
export const connectionHealthSchema = z.enum(CONNECTION_HEALTH);
export type ConnectionHealth = z.infer<typeof connectionHealthSchema>;

export const connectionSchema = z.strictObject({
  connectionId: idSchema,
  label: titleSchema,
  /** Registry key for the live adapter. Stable for the connection's lifetime. */
  adapterId: slugSchema,
  vendorId: vendorIdSchema,
  config: connectionConfigSchema,
  /** Null for a local runtime, which needs no credential at all. */
  credentialRef: credentialRefSchema.nullable(),
  /** A disabled connection keeps its settings but is not registered. */
  enabled: z.boolean(),
  health: connectionHealthSchema,
  healthDetail: z.string().max(500).nullable(),
  /** How many models the last successful test could see. */
  modelCount: z.number().int().nonnegative().nullable(),
  checkedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Connection = z.infer<typeof connectionSchema>;

/** The outcome of testing a connection, before it is written down. */
export const connectionCheckSchema = z.strictObject({
  health: connectionHealthSchema,
  detail: z.string().max(500).nullable(),
  modelCount: z.number().int().nonnegative().nullable(),
  checkedAt: timestampSchema,
});
export type ConnectionCheck = z.infer<typeof connectionCheckSchema>;

/**
 * Whose weights a connection reaches.
 *
 * Derived from the config rather than stored beside it, so the two cannot
 * disagree — and P1's independence check reads this, so a wrong answer here
 * would let a model critique its own work.
 */
export function vendorIdForConfig(config: ConnectionConfig): VendorId {
  switch (config.kind) {
    case 'anthropic':
      return 'anthropic';
    case 'openai-compatible':
      return namesItsVendor(config.preset) ? (config.vendorId ?? config.preset) : config.preset;
    // Azure serves OpenAI's weights; the hosting arrangement is not a vendor.
    case 'azure-openai':
      return 'openai';
    case 'google':
    case 'google-oauth':
      return 'google';
    case 'local':
      return config.provider;
  }
}

/**
 * Endpoints that serve other makers' models, so that the endpoint's own name
 * says nothing about whose weights answer. The connection says instead.
 */
export function namesItsVendor(preset: OpenAiPresetId): boolean {
  return preset === 'custom' || preset === 'ollama-cloud';
}

/** What kind of secret this connection stores, or null if it stores none. */
export function credentialKindForConfig(config: ConnectionConfig): CredentialKind | null {
  switch (config.kind) {
    case 'google-oauth':
      return 'oauth-refresh-token';
    case 'local':
      return null;
    default:
      return 'api-key';
  }
}

/** True when a connection cannot work until a secret has been supplied. */
export function requiresSecret(config: ConnectionConfig): boolean {
  return credentialKindForConfig(config) !== null;
}

/**
 * True when the secret is obtained by signing in rather than by pasting.
 *
 * The distinction the UI needs: an OAuth connection must never show a field
 * that invites someone to paste a token into it.
 */
export function usesInteractiveSignIn(config: ConnectionConfig): boolean {
  return config.kind === 'google-oauth';
}

/**
 * Rules the schema alone cannot state: `custom` has no preset to fall back on,
 * so it must bring its own base URL and its own vendor.
 *
 * Returned as a list rather than thrown, because this runs behind a form and
 * every problem with what was typed should be visible at once.
 */
export function connectionConfigIssues(config: ConnectionConfig): string[] {
  const issues: string[] = [];
  if (config.kind === 'openai-compatible' && config.preset === 'custom') {
    if (config.baseUrl === undefined) issues.push('a custom endpoint needs a base URL');
    if (config.vendorId === undefined) {
      issues.push('a custom endpoint needs a vendor id, so critiques stay cross-vendor');
    }
  }
  // A key sent over plain http is readable by everything between here and there.
  // This machine is the exception: a local proxy has no wire to listen on.
  const endpoint = 'endpoint' in config ? config.endpoint : 'baseUrl' in config && config.baseUrl;
  if (requiresSecret(config) && endpoint && !/^https:/i.test(endpoint) && !isLoopback(endpoint)) {
    issues.push('an endpoint that is sent a key must be https, unless it is on this machine');
  }
  return issues;
}

function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

/** A short, stable, recognisable prefix for a connection's adapter id. */
export function adapterPrefixFor(config: ConnectionConfig): string {
  switch (config.kind) {
    case 'openai-compatible':
      return config.preset === 'custom' ? (config.vendorId ?? 'custom') : config.preset;
    case 'local':
      return config.provider;
    default:
      return config.kind;
  }
}

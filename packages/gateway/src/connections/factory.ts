import {
  connectionConfigIssues,
  vendorIdForConfig,
  type ConnectionCheck,
  type ConnectionConfig,
  type ConnectionHealth,
} from '@sheep/core';
import type { AdapterId, ModelAdapter } from '../adapter';
import { AnthropicAdapter } from '../adapters/anthropic';
import { GoogleAdapter } from '../adapters/google';
import { createLocalAdapter } from '../adapters/local';
import {
  createAzureOpenAiAdapter,
  createOpenAiAdapter,
  OpenAiCompatibleAdapter,
  OPENAI_DEFAULT_CAPABILITIES,
} from '../adapters/openai';
import type { SecretProvider } from '../credentials';
import { CredentialError, GatewayError, ProviderError, TransportError } from '../errors';
import type { FetchLike } from '../http/client';

/**
 * Stored configuration in, live adapter out.
 *
 * This is the only place that maps a `ConnectionConfig` onto a constructor, and
 * keeping it in one function is what lets the desktop app store connections as
 * data: adding a provider is a case here plus an entry in the config union, and
 * nothing above the gateway learns a new shape.
 */

export class ConnectionConfigError extends GatewayError {
  readonly code = 'GATEWAY_INVALID_REQUEST' as const;

  constructor(readonly issues: readonly string[]) {
    super(`This connection cannot be built: ${issues.join('; ')}`);
    this.name = 'ConnectionConfigError';
  }
}

export interface BuildAdapterOptions {
  /** Registry key. Normally the connection's own stable `adapterId`. */
  readonly adapterId: AdapterId;
  readonly config: ConnectionConfig;
  /**
   * How to obtain the secret — a function, so a rotated key takes effect on the
   * next call and no long-lived object here holds one.
   */
  readonly secret?: SecretProvider;
  /** A live OAuth access token, for connections that sign in rather than paste. */
  readonly accessToken?: () => Promise<string>;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export function buildAdapter(options: BuildAdapterOptions): ModelAdapter {
  const { config } = options;

  const issues = connectionConfigIssues(config);
  if (issues.length > 0) throw new ConnectionConfigError(issues);

  const shared = {
    adapterId: options.adapterId,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  switch (config.kind) {
    case 'anthropic':
      return new AnthropicAdapter({
        ...shared,
        apiKey: requireSecret(options, 'an API key'),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      });

    case 'openai-compatible': {
      if (config.preset === 'custom') {
        // Validated above, so the assertions here are about narrowing rather
        // than about trusting the caller.
        return new OpenAiCompatibleAdapter({
          ...shared,
          vendorId: vendorIdForConfig(config),
          baseUrl: config.baseUrl ?? '',
          apiKey: requireSecret(options, 'an API key'),
          defaultCapabilities: OPENAI_DEFAULT_CAPABILITIES,
        });
      }
      return createOpenAiAdapter(config.preset, {
        ...shared,
        apiKey: requireSecret(options, 'an API key'),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      });
    }

    case 'azure-openai':
      return createAzureOpenAiAdapter({
        adapterId: options.adapterId,
        endpoint: config.endpoint,
        apiVersion: config.apiVersion,
        apiKey: requireSecret(options, 'an API key'),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });

    case 'google':
      return new GoogleAdapter({
        ...shared,
        credentials: { kind: 'apiKey', apiKey: requireSecret(options, 'an API key') },
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      });

    case 'google-oauth': {
      const accessToken = options.accessToken;
      if (!accessToken) {
        throw new CredentialError(options.adapterId, 'this connection is not signed in');
      }
      return new GoogleAdapter({ ...shared, credentials: { kind: 'oauth', accessToken } });
    }

    case 'local':
      // The connection's own id, not the runtime's name: two Ollama servers on
      // one machine are a legitimate setup, and both must be registrable.
      return createLocalAdapter(config.provider, {
        adapterId: options.adapterId,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
  }
}

function requireSecret(options: BuildAdapterOptions, what: string): SecretProvider {
  if (options.secret === undefined) {
    throw new CredentialError(options.adapterId, `this connection has no ${what} stored`);
  }
  return options.secret;
}

/**
 * Ask the provider whether this connection actually works.
 *
 * `listModels()` is the probe because it is the cheapest call that exercises
 * the whole path — URL, credential, and the provider's willingness to answer —
 * without spending a token. What it returns matters less than what it costs to
 * find out that it will not.
 *
 * Never throws. A health check that can fail in a way the UI must also handle
 * has two failure paths where one would do.
 */
export async function checkAdapter(
  adapter: ModelAdapter,
  options: { readonly now?: () => Date; readonly signal?: AbortSignal } = {},
): Promise<ConnectionCheck> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();

  try {
    const models = await adapter.listModels({
      refresh: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      health: 'ok',
      detail: `${String(models.length)} model${models.length === 1 ? '' : 's'} reachable`,
      modelCount: models.length,
      checkedAt,
    };
  } catch (error) {
    return { ...classify(error), modelCount: null, checkedAt };
  }
}

/**
 * Why a check failed, in terms the user can act on.
 *
 * 401 and 403 are separated from everything else because they are the one
 * outcome where the fix is a credential rather than a network or a URL — and a
 * badge that says "unreachable" for a rejected key sends people to look at
 * their firewall.
 */
function classify(error: unknown): { health: ConnectionHealth; detail: string } {
  if (error instanceof CredentialError) {
    return { health: 'unauthorized', detail: error.message };
  }
  if (error instanceof ConnectionConfigError) {
    return { health: 'misconfigured', detail: error.message };
  }
  if (error instanceof ProviderError) {
    const health: ConnectionHealth =
      error.status === 401 || error.status === 403 ? 'unauthorized' : 'unreachable';
    return { health, detail: error.message.slice(0, 500) };
  }
  if (error instanceof TransportError) {
    return { health: 'unreachable', detail: error.message.slice(0, 500) };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { health: 'unreachable', detail: detail.slice(0, 500) };
}

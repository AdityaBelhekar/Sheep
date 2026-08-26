import { CredentialError } from '../errors';
import type { FetchLike } from '../http/client';
import { startLoopbackServer, type LoopbackOptions } from './loopback';
import { createPkcePair, createState } from './pkce';

/**
 * An OAuth 2.0 authorization-code flow with PKCE, for a desktop app.
 *
 * Generic on purpose: Google is the first provider to need it (Phase 14) and
 * will not be the last, and none of the mechanism — loopback redirect, code
 * challenge, refresh-before-expiry — is Google-specific. What is specific are
 * three URLs and a scope list, which arrive as config.
 */

export interface OAuthEndpoints {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  /** Optional, and best-effort: revoking is polite, never load-bearing. */
  readonly revocationUrl?: string;
}

export interface OAuthClientOptions {
  readonly endpoints: OAuthEndpoints;
  /** Public by definition in a native app — which is exactly why PKCE exists. */
  readonly clientId: string;
  /**
   * Only for providers that insist on one for installed apps. Not a secret in
   * any meaningful sense; PKCE is what actually protects the exchange.
   */
  readonly clientSecret?: string;
  readonly scopes: readonly string[];
  /** Extra authorization parameters, e.g. Google's `access_type=offline`. */
  readonly authorizationParams?: Record<string, string>;
  readonly fetch?: FetchLike;
  /** Overridable so tests can run without a clock. */
  readonly now?: () => number;
}

/**
 * What a sign-in produced.
 *
 * `refreshToken` is the part worth protecting: it is a long-lived credential
 * and belongs in the OS keychain (Phase 9), never in SQLite. The access token
 * is short-lived and is kept in memory only.
 */
export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly scope?: string;
  readonly tokenType: string;
}

export interface SignInOptions extends LoopbackOptions {
  /**
   * Opens the user's browser. Injected rather than imported so this package
   * stays free of Electron — the desktop app passes `shell.openExternal`.
   */
  readonly openBrowser: (url: string) => void | Promise<void>;
  /** Google needs this to re-issue a refresh token on a repeat sign-in. */
  readonly prompt?: string;
  readonly loginHint?: string;
}

/** Refresh this long before expiry rather than at it. */
const EXPIRY_SKEW_MS = 60_000;

export class OAuthClient {
  readonly #options: OAuthClientOptions;
  readonly #fetch: FetchLike;
  readonly #now: () => number;

  constructor(options: OAuthClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * The whole sign-in: listen, open the browser, wait, exchange.
   *
   * The loopback server is started *before* the browser opens, because the
   * redirect URI has to name a port that is already listening; and it is closed
   * in a `finally`, because a sign-in the user abandons must not leave a socket
   * bound for the rest of the session.
   */
  async signIn(options: SignInOptions): Promise<TokenSet> {
    const pkce = createPkcePair();
    const state = createState();
    const server = await startLoopbackServer(options);

    try {
      const url = this.authorizationUrl({
        redirectUri: server.redirectUri,
        challenge: pkce.challenge,
        state,
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
        ...(options.loginHint === undefined ? {} : { loginHint: options.loginHint }),
      });
      await options.openBrowser(url);

      const redirect = await server.waitForRedirect();
      // A redirect carrying someone else's state is an attempt to graft a
      // different account onto this sign-in; the code is not redeemed.
      if (redirect.state !== state) {
        throw new CredentialError('oauth', 'the redirect state did not match the request');
      }

      return await this.exchangeCode({
        code: redirect.code,
        redirectUri: server.redirectUri,
        verifier: pkce.verifier,
      });
    } finally {
      await server.close();
    }
  }

  authorizationUrl(params: {
    redirectUri: string;
    challenge: string;
    state: string;
    prompt?: string;
    loginHint?: string;
  }): string {
    const url = new URL(this.#options.endpoints.authorizationUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.#options.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('scope', this.#options.scopes.join(' '));
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (params.prompt) url.searchParams.set('prompt', params.prompt);
    if (params.loginHint) url.searchParams.set('login_hint', params.loginHint);
    for (const [key, value] of Object.entries(this.#options.authorizationParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    verifier: string;
  }): Promise<TokenSet> {
    return await this.#token({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.verifier,
    });
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const refreshed = await this.#token({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    // Most providers do not re-send the refresh token; keep the one we have.
    return refreshed.refreshToken ? refreshed : { ...refreshed, refreshToken };
  }

  /** Best effort — a provider that will not revoke is not a failure to report. */
  async revoke(token: string): Promise<boolean> {
    const url = this.#options.endpoints.revocationUrl;
    if (!url) return false;
    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** True when the token is expired, or close enough that it soon will be. */
  isExpired(tokens: TokenSet): boolean {
    return tokens.expiresAt - EXPIRY_SKEW_MS <= this.#now();
  }

  async #token(form: Record<string, string>): Promise<TokenSet> {
    const body = new URLSearchParams({
      ...form,
      client_id: this.#options.clientId,
      ...(this.#options.clientSecret ? { client_secret: this.#options.clientSecret } : {}),
    });

    const response = await this.#fetch(this.#options.endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });

    const text = await response.text();
    if (!response.ok) {
      // The body names the reason (`invalid_grant` for a revoked refresh token,
      // most often) and carries no secret of ours, so it is worth surfacing.
      throw new CredentialError(
        'oauth',
        `token endpoint returned ${String(response.status)}: ${text.slice(0, 300)}`,
      );
    }

    const payload = JSON.parse(text) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };
    if (!payload.access_token) {
      throw new CredentialError('oauth', 'the token response carried no access token');
    }

    return {
      accessToken: payload.access_token,
      ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
      // A provider that omits `expires_in` is assumed to mean an hour.
      expiresAt: this.#now() + (payload.expires_in ?? 3600) * 1000,
      ...(payload.scope ? { scope: payload.scope } : {}),
      tokenType: payload.token_type ?? 'Bearer',
    };
  }
}

/**
 * Where the refresh token lives.
 *
 * An interface rather than an implementation because the gateway must not know
 * what a keychain is: the desktop app supplies one backed by Phase 9's vault,
 * and a test supplies an object in memory.
 */
export interface TokenStore {
  load(): TokenSet | null | Promise<TokenSet | null>;
  save(tokens: TokenSet): void | Promise<void>;
  clear?(): void | Promise<void>;
}

/** A `TokenStore` in memory. For tests and for a session that must not persist. */
export function memoryTokenStore(initial: TokenSet | null = null): TokenStore {
  let current = initial;
  return {
    load: () => current,
    save: (tokens) => {
      current = tokens;
    },
    clear: () => {
      current = null;
    },
  };
}

/**
 * A live access token, refreshed when it needs to be.
 *
 * Returns the function shape adapters already take for an API key, so a signed
 * -in connection and a pasted-key connection are the same thing to everything
 * downstream — which is what makes "no key pasted" a real outcome rather than a
 * second code path.
 */
export function accessTokenProvider(client: OAuthClient, store: TokenStore): () => Promise<string> {
  let inFlight: Promise<TokenSet> | undefined;

  return async () => {
    const tokens = await store.load();
    if (!tokens) throw new CredentialError('oauth', 'not signed in');
    if (!client.isExpired(tokens)) return tokens.accessToken;
    if (!tokens.refreshToken) {
      throw new CredentialError('oauth', 'the session expired and there is no refresh token');
    }

    // Six parallel streams hitting an expired token must produce one refresh,
    // not six — the extra five would each invalidate the last on some providers.
    inFlight ??= client
      .refresh(tokens.refreshToken)
      .then(async (next) => {
        await store.save(next);
        return next;
      })
      .finally(() => {
        inFlight = undefined;
      });

    return (await inFlight).accessToken;
  };
}

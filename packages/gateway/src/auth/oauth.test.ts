import { describe, expect, it } from 'vitest';
import { CredentialError } from '../errors';
import { errorResponse, fakeFetch, jsonResponse } from '../http/test-support';
import { startLoopbackServer } from './loopback';
import { accessTokenProvider, memoryTokenStore, OAuthClient } from './oauth';
import { challengeFor, createPkcePair } from './pkce';

const ENDPOINTS = {
  authorizationUrl: 'https://accounts.example.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.example.com/token',
  revocationUrl: 'https://oauth2.example.com/revoke',
};

describe('PKCE', () => {
  it('produces a fresh verifier whose challenge is its S256 hash', () => {
    const first = createPkcePair();
    const second = createPkcePair();

    expect(first.verifier).not.toBe(second.verifier);
    expect(first.method).toBe('S256');
    expect(first.challenge).toBe(challengeFor(first.verifier));
    // base64url: no padding, no characters that would need escaping in a URL.
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });
});

describe('loopback redirect', () => {
  it('listens on 127.0.0.1, hands back the code, and stops listening', async () => {
    const server = await startLoopbackServer({ timeoutMs: 5_000 });
    expect(server.redirectUri).toBe(`http://127.0.0.1:${String(server.port)}/callback`);

    const pending = server.waitForRedirect();
    const browser = await fetch(`${server.redirectUri}?code=abc123&state=xyz`);
    expect(browser.status).toBe(200);
    expect(await browser.text()).toContain('Signed in');

    await expect(pending).resolves.toEqual({ code: 'abc123', state: 'xyz' });

    await server.close();
    await expect(fetch(server.redirectUri)).rejects.toThrow();
  });

  it('reports the user pressing cancel', async () => {
    const server = await startLoopbackServer({ timeoutMs: 5_000 });
    // The assertion is attached before the redirect lands: the rejection is
    // raised from inside the request handler, and nothing may be waiting late.
    const pending = expect(server.waitForRedirect()).rejects.toThrow(/access_denied/);

    await fetch(`${server.redirectUri}?error=access_denied`);
    await pending;
    await server.close();
  });
});

describe('OAuthClient', () => {
  it('signs in end to end and never sends a client secret it does not have', async () => {
    const http = fakeFetch([
      jsonResponse({
        access_token: 'ya29.access',
        refresh_token: '1//refresh',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        token_type: 'Bearer',
      }),
    ]);
    const client = new OAuthClient({
      endpoints: ENDPOINTS,
      clientId: 'sheep-desktop.apps.example.com',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      authorizationParams: { access_type: 'offline' },
      fetch: http.fetch,
      now: () => 1_000_000,
    });

    let visited: URL | undefined;
    const tokens = await client.signIn({
      timeoutMs: 5_000,
      // Stands in for the user's browser: follow the URL, come back with a code.
      openBrowser: async (url) => {
        visited = new URL(url);
        await fetch(
          `${visited.searchParams.get('redirect_uri') ?? ''}?code=auth-code&state=${
            visited.searchParams.get('state') ?? ''
          }`,
        );
      },
    });

    expect(`${visited?.origin ?? ''}${visited?.pathname ?? ''}`).toBe(ENDPOINTS.authorizationUrl);
    expect(visited?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(visited?.searchParams.get('access_type')).toBe('offline');
    expect(visited?.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    // The verifier is never in the browser URL — only its hash.
    expect(visited?.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The exchange: the verifier goes out exactly once, and there is no secret.
    const form = new URLSearchParams(String(http.calls[0]?.body ?? ''));
    expect(http.calls[0]?.url).toBe(ENDPOINTS.tokenUrl);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('auth-code');
    expect(challengeFor(form.get('code_verifier') ?? '')).toBe(
      visited?.searchParams.get('code_challenge'),
    );
    expect(form.get('client_secret')).toBeNull();
    expect(tokens).toEqual({
      accessToken: 'ya29.access',
      refreshToken: '1//refresh',
      expiresAt: 1_000_000 + 3_600_000,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      tokenType: 'Bearer',
    });
  });

  it('refuses a redirect whose state does not match', async () => {
    const http = fakeFetch([]);
    const client = new OAuthClient({
      endpoints: ENDPOINTS,
      clientId: 'sheep',
      scopes: ['scope'],
      fetch: http.fetch,
    });

    await expect(
      client.signIn({
        timeoutMs: 5_000,
        openBrowser: async (url) => {
          const redirect = new URL(url).searchParams.get('redirect_uri') ?? '';
          await fetch(`${redirect}?code=auth-code&state=not-the-state`);
        },
      }),
    ).rejects.toThrow(CredentialError);
    // The code was never redeemed.
    expect(http.calls).toHaveLength(0);
  });

  it('keeps the refresh token when the provider does not resend it', async () => {
    const http = fakeFetch([jsonResponse({ access_token: 'second', expires_in: 3600 })]);
    const client = new OAuthClient({
      endpoints: ENDPOINTS,
      clientId: 'sheep',
      scopes: ['scope'],
      fetch: http.fetch,
      now: () => 0,
    });

    const refreshed = await client.refresh('1//refresh');
    expect(refreshed).toMatchObject({ accessToken: 'second', refreshToken: '1//refresh' });
  });

  it('reports a revoked grant with the provider’s own reason', async () => {
    const http = fakeFetch([errorResponse(400, { error: 'invalid_grant' })]);
    const client = new OAuthClient({
      endpoints: ENDPOINTS,
      clientId: 'sheep',
      scopes: ['scope'],
      fetch: http.fetch,
    });

    await expect(client.refresh('stale')).rejects.toThrow(/invalid_grant/);
  });
});

describe('accessTokenProvider', () => {
  it('returns a live token, refreshes an expired one, and refreshes once', async () => {
    let now = 10_000_000;
    const http = fakeFetch(() =>
      jsonResponse({ access_token: `fresh-${String(now)}`, expires_in: 3600 }),
    );
    const client = new OAuthClient({
      endpoints: ENDPOINTS,
      clientId: 'sheep',
      scopes: ['scope'],
      fetch: http.fetch,
      now: () => now,
    });
    const store = memoryTokenStore({
      accessToken: 'stale',
      refreshToken: '1//refresh',
      expiresAt: now + 3_600_000,
      tokenType: 'Bearer',
    });
    const token = accessTokenProvider(client, store);

    expect(await token()).toBe('stale');
    expect(http.calls).toHaveLength(0);

    // Past expiry: six concurrent streams must cause exactly one refresh.
    now += 3_600_001;
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => token()));
    expect(new Set(concurrent).size).toBe(1);
    expect(http.calls).toHaveLength(1);

    // The refreshed token was persisted, so the next call needs no network.
    expect(await token()).toBe(concurrent[0]);
    expect(http.calls).toHaveLength(1);
  });

  it('says plainly when nobody is signed in', async () => {
    const client = new OAuthClient({
      endpoints: ENDPOINTS,
      clientId: 'sheep',
      scopes: ['scope'],
      fetch: fakeFetch([]).fetch,
    });
    await expect(accessTokenProvider(client, memoryTokenStore())()).rejects.toThrow(
      /not signed in/,
    );
  });
});

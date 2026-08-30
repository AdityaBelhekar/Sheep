import { shell } from 'electron';
import {
  credentialKindForConfig,
  usesInteractiveSignIn,
  type Connection,
  type ConnectionCheck,
  type ConnectionConfig,
} from '@sheep/core';
import {
  AdapterRegistry,
  buildAdapter,
  checkAdapter,
  createGoogleOAuthClient,
  detectLocalProviders,
  withResilience,
  type LocalProviderStatus,
  type ModelAdapter,
  type ModelHandle,
  type TokenSet,
  type TokenStore,
} from '@sheep/gateway';
import { deleteCredential, getVault, readCredential, saveCredential } from './credentials';
import { logInfo, logWarn } from './log';
import { getStore } from './store';

/**
 * The live half of a connection.
 *
 * A row in the `connections` table is inert configuration; an entry in the
 * `AdapterRegistry` is a thing that can make a call. This module is the only
 * place the two are reconciled, and it reconciles in one direction only —
 * database to registry — so the registry can always be rebuilt from what is
 * stored, and never accumulates an adapter nothing remembers configuring.
 *
 * Secrets are reached through a closure rather than captured at build time.
 * Rotating a key therefore takes effect on the next call, and no adapter
 * sitting in this process holds a secret waiting to be serialised into a crash
 * dump.
 */

/**
 * Conservative enough not to trip a provider's own limit on a first run, and
 * generous enough for the six concurrent streams Stage 3 has to survive.
 */
const RATE_LIMIT = { capacity: 8, refillPerSecond: 2 } as const;

let registry: AdapterRegistry | undefined;
/** Which stored connection each registered adapter came from. */
const sources = new Map<string, { connectionId: string; updatedAt: string }>();

export function getAdapterRegistry(): AdapterRegistry {
  registry ??= new AdapterRegistry();
  return registry;
}

/**
 * Brings the registry in line with the database.
 *
 * Runs at launch and after every write, and is deliberately idempotent: an
 * unchanged connection keeps the adapter it already had, so a settings edit
 * elsewhere does not tear down a connection mid-stream. `updatedAt` is what
 * decides "unchanged", which is why the registry resets it on every edit.
 */
export async function syncConnections(): Promise<void> {
  const live = getAdapterRegistry();
  const stored = getStore().connections.listEnabled();
  const wanted = new Map(stored.map((connection) => [connection.adapterId, connection]));

  for (const adapterId of [...sources.keys()]) {
    const connection = wanted.get(adapterId);
    const source = sources.get(adapterId);
    if (connection && source && connection.updatedAt === source.updatedAt) continue;
    await live.unregister(adapterId);
    sources.delete(adapterId);
  }

  for (const connection of stored) {
    if (live.has(connection.adapterId)) continue;
    try {
      live.register(adapterFor(connection));
      sources.set(connection.adapterId, {
        connectionId: connection.connectionId,
        updatedAt: connection.updatedAt,
      });
    } catch (error) {
      // A connection that cannot be built is a configuration problem the user
      // sees on its badge; it must not stop the others from registering.
      logWarn(`connection ${connection.label} could not be built -`, error);
      recordCheckFor(connection.connectionId, {
        health: 'misconfigured',
        detail: error instanceof Error ? error.message : String(error),
        modelCount: null,
        checkedAt: new Date().toISOString(),
      });
    }
  }
}

/** Builds the adapter for one connection, wrapped in the resilience layer. */
function adapterFor(connection: Connection): ModelAdapter {
  const store = getStore();
  const credentialRef = connection.credentialRef;

  const adapter = buildAdapter({
    adapterId: connection.adapterId,
    config: connection.config,
    ...(credentialRef && !usesInteractiveSignIn(connection.config)
      ? { secret: () => resolveSecret(credentialRef) }
      : {}),
    ...(credentialRef && usesInteractiveSignIn(connection.config)
      ? { accessToken: oauthAccessToken(connection, credentialRef) }
      : {}),
  });

  // Every exchange lands in the content-addressed store by hash, which is what
  // makes a session replayable without re-spending (P5).
  return withResilience(adapter, {
    rateLimit: RATE_LIMIT,
    blobs: store.blobs,
    onExchange: (record) => {
      logInfo(
        `exchange ${record.adapterId}/${record.modelId} · ${String(record.deltaCount)} deltas · ` +
          `request ${record.requestHash.slice(0, 12)} · transcript ${record.transcriptHash.slice(0, 12)}` +
          (record.partial ? ' · PARTIAL' : ''),
      );
    },
  });
}

async function resolveSecret(credentialRef: string): Promise<string> {
  const secret = await readCredential(credentialRef);
  if (secret === undefined) throw new Error(`no secret is stored under ${credentialRef}`);
  return secret;
}

/**
 * The OAuth token set, kept in the OS credential store.
 *
 * The whole set goes in rather than only the refresh token: the refresh token
 * is the part that must be protected, and the access token beside it is short
 * -lived and no more sensitive — while keeping them together means a restart
 * resumes without a round trip to the token endpoint.
 */
function oauthTokenStore(credentialRef: string): TokenStore {
  return {
    async load() {
      const raw = await readCredential(credentialRef);
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw) as TokenSet;
      } catch {
        return null;
      }
    },
    async save(tokens) {
      await getVault().set(credentialRef, JSON.stringify(tokens));
    },
  };
}

function oauthAccessToken(connection: Connection, credentialRef: string): () => Promise<string> {
  if (connection.config.kind !== 'google-oauth') {
    throw new Error('only a google-oauth connection has an access token');
  }
  const client = createGoogleOAuthClient({ clientId: connection.config.clientId });
  const store = oauthTokenStore(credentialRef);

  // Not `accessTokenProvider`, because that caches a client per call site and
  // this closure is rebuilt whenever the connection is, which is rarely enough
  // that a load per call is cheaper than the bookkeeping.
  return async () => {
    const tokens = await store.load();
    if (!tokens) throw new Error('this connection is not signed in');
    if (!client.isExpired(tokens)) return tokens.accessToken;
    if (!tokens.refreshToken) throw new Error('the sign-in expired; sign in again');
    const refreshed = await client.refresh(tokens.refreshToken);
    await store.save(refreshed);
    return refreshed.accessToken;
  };
}

export interface CreateConnectionInput {
  readonly label: string;
  readonly config: ConnectionConfig;
  readonly secret?: string;
  readonly enabled?: boolean;
}

/**
 * Stores a connection, and its secret if it has one.
 *
 * The secret is written first, exactly as `saveCredential` does for the same
 * reason: a connection row pointing at a credential that was never written is
 * worse than a credential nothing points at.
 */
export async function createConnection(input: CreateConnectionInput): Promise<Connection> {
  const kind = credentialKindForConfig(input.config);
  let credentialRef: string | null = null;

  if (input.secret !== undefined && kind !== null) {
    credentialRef = await saveCredential({
      label: input.label,
      vendorId: vendorLabelFor(input.config),
      kind,
      secret: input.secret,
    });
  }

  const connection = getStore().connections.add({
    label: input.label,
    config: input.config,
    credentialRef,
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
  });

  await syncConnections();
  return connection;
}

export interface UpdateConnectionInput {
  readonly connectionId: string;
  readonly label?: string;
  readonly config?: ConnectionConfig;
  /** Present only when the secret is being replaced. */
  readonly secret?: string;
  readonly enabled?: boolean;
}

export async function updateConnection(input: UpdateConnectionInput): Promise<Connection> {
  const store = getStore();
  const existing = store.connections.get(input.connectionId);
  if (!existing) throw new Error(`unknown connection: ${input.connectionId}`);

  const config = input.config ?? existing.config;
  const kind = credentialKindForConfig(config);
  let credentialRef = existing.credentialRef;

  if (input.secret !== undefined && kind !== null) {
    // A replacement key is written before the old one is forgotten, so a
    // failure here leaves the connection working with what it had.
    const replacement = await saveCredential({
      label: input.label ?? existing.label,
      vendorId: vendorLabelFor(config),
      kind,
      secret: input.secret,
    });
    if (existing.credentialRef) await deleteCredential(existing.credentialRef).catch(() => false);
    credentialRef = replacement;
  } else if (kind === null && existing.credentialRef) {
    // The kind changed to one that needs no secret; the old one has no owner.
    await deleteCredential(existing.credentialRef).catch(() => false);
    credentialRef = null;
  }

  const updated = store.connections.update(input.connectionId, {
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.config === undefined ? {} : { config: input.config }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    credentialRef,
  });

  await syncConnections();
  return updated;
}

/** Removes the connection, the live adapter and the secret, in that order. */
export async function deleteConnection(connectionId: string): Promise<boolean> {
  const store = getStore();
  const existing = store.connections.get(connectionId);
  if (!existing) return false;

  await getAdapterRegistry().unregister(existing.adapterId);
  sources.delete(existing.adapterId);
  const removed = store.connections.remove(connectionId);
  if (existing.credentialRef) await deleteCredential(existing.credentialRef).catch(() => false);
  return removed;
}

/** Tests a connection against the provider and stores the verdict. */
export async function testConnection(connectionId: string): Promise<Connection> {
  const store = getStore();
  const connection = store.connections.get(connectionId);
  if (!connection) throw new Error(`unknown connection: ${connectionId}`);

  await syncConnections();
  const adapter = getAdapterRegistry().has(connection.adapterId)
    ? getAdapterRegistry().get(connection.adapterId)
    : undefined;

  const check: ConnectionCheck = adapter
    ? await checkAdapter(adapter)
    : {
        health: connection.enabled ? 'misconfigured' : 'unknown',
        detail: connection.enabled
          ? 'this connection could not be built from its settings'
          : 'this connection is disabled',
        modelCount: null,
        checkedAt: new Date().toISOString(),
      };

  // A working test also proves the credential still works, which is what the
  // credential list's own "last verified" column is for.
  if (check.health === 'ok' && connection.credentialRef) {
    store.credentials.markVerified(connection.credentialRef);
  }

  recordCheckFor(connectionId, check);
  return store.connections.get(connectionId) ?? connection;
}

/**
 * The Google sign-in: loopback redirect, PKCE, refresh token to the keychain.
 *
 * The browser that opens is the user's own, which is the point of the loopback
 * flow rather than an embedded webview — the real address bar, the real
 * padlock, and no opportunity for Sheep to see the password.
 */
export async function signInConnection(connectionId: string): Promise<Connection> {
  const store = getStore();
  const connection = store.connections.get(connectionId);
  if (!connection) throw new Error(`unknown connection: ${connectionId}`);
  if (connection.config.kind !== 'google-oauth') {
    throw new Error('this connection does not sign in');
  }

  const client = createGoogleOAuthClient({ clientId: connection.config.clientId });
  const tokens = await client.signIn({
    openBrowser: (url) => {
      void shell.openExternal(url);
    },
    // Without it, a second sign-in returns an access token and no way to renew.
    prompt: 'consent',
  });

  let credentialRef = connection.credentialRef;
  if (credentialRef) {
    await getVault().set(credentialRef, JSON.stringify(tokens));
  } else {
    credentialRef = await saveCredential({
      label: connection.label,
      vendorId: connection.vendorId,
      kind: 'oauth-refresh-token',
      secret: JSON.stringify(tokens),
    });
    store.connections.update(connectionId, { credentialRef });
  }

  await syncConnections();
  return await testConnection(connectionId);
}

/** What this machine can run locally. Never throws; absence is an answer. */
export async function detectLocal(): Promise<LocalProviderStatus[]> {
  return await detectLocalProviders({ timeoutMs: 1_500 });
}

/**
 * Every model reachable through every enabled connection.
 *
 * A failing connection contributes nothing rather than failing the whole call:
 * one unreachable provider must not make the roster unusable.
 */
export async function listAvailableModels(
  options: { refresh?: boolean } = {},
): Promise<{ handles: ModelHandle[]; failures: { adapterId: string; detail: string }[] }> {
  await syncConnections();
  const live = getAdapterRegistry();
  const handles: ModelHandle[] = [];
  const failures: { adapterId: string; detail: string }[] = [];

  await Promise.all(
    live.adapters().map(async (adapter) => {
      try {
        const descriptors = await adapter.listModels(
          options.refresh === undefined ? {} : { refresh: options.refresh },
        );
        for (const descriptor of descriptors) {
          handles.push({ adapterId: adapter.adapterId, descriptor });
        }
      } catch (error) {
        failures.push({
          adapterId: adapter.adapterId,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  handles.sort(
    (a, b) =>
      a.descriptor.vendorId.localeCompare(b.descriptor.vendorId) ||
      a.descriptor.displayName.localeCompare(b.descriptor.displayName),
  );
  return { handles, failures };
}

function recordCheckFor(connectionId: string, check: ConnectionCheck): void {
  getStore().connections.recordCheck(connectionId, check);
}

/** The vendor a credential is filed under, so the credential list reads sensibly. */
function vendorLabelFor(config: ConnectionConfig): string {
  return config.kind === 'azure-openai' ? 'azure-openai' : vendorOf(config);
}

function vendorOf(config: ConnectionConfig): string {
  switch (config.kind) {
    case 'openai-compatible':
      return config.preset === 'custom' ? (config.vendorId ?? 'custom') : config.preset;
    case 'local':
      return config.provider;
    case 'google-oauth':
      return 'google';
    default:
      return config.kind;
  }
}

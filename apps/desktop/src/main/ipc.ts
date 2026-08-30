import { randomUUID } from 'node:crypto';
import { app, ipcMain } from 'electron';
import { domainEvent, type Connection } from '@sheep/core';
import { IpcError, IpcRegistry } from '@sheep/ipc';
import { listSessions } from '@sheep/store';
import { APP_NAME } from '../shared/product';
import {
  createConnection,
  deleteConnection,
  detectLocal,
  signInConnection,
  testConnection,
  updateConnection,
} from './connections';
import { getVault } from './credentials';
import { getEventLog, getStore } from './store';

/** Builds the main-process registry with every handler this app serves. */
export function createIpcRegistry(): IpcRegistry {
  return new IpcRegistry()
    .register('sheep:ping', (request) => {
      const receivedAt = Date.now();
      return {
        pong: true as const,
        app: APP_NAME,
        version: app.getVersion(),
        receivedAt,
        elapsedMs: receivedAt - request.sentAt,
      };
    })
    .register('sheep:event-log-summary', () => {
      const store = getStore();
      const log = getEventLog();
      const verification = log.verify();

      return {
        count: log.count(),
        schemaVersion: store.schemaVersion,
        driver: store.driver,
        journalMode: store.journalMode,
        head: verification.head ?? null,
        chain: {
          ok: verification.ok,
          checked: verification.checked,
          failures: verification.failures.map((failure) => ({
            seq: failure.seq,
            reason: failure.reason,
            detail: failure.detail,
          })),
        },
      };
    })
    .register('sheep:settings-read', () => ({ settings: getStore().settings.getAll() }))
    .register('sheep:settings-write', (request) => ({
      settings: getStore().settings.apply(request),
    }))
    .register('sheep:credential-summary', () => {
      const vault = getVault();
      return {
        backend: vault.backend,
        description: vault.description,
        // Handles and labels only. No channel in this app returns a secret.
        credentials: getStore()
          .credentials.list()
          .map((record) => ({
            credentialRef: record.credentialRef,
            label: record.label,
            vendorId: record.vendorId,
            kind: record.kind,
            lastVerifiedAt: record.lastVerifiedAt,
          })),
      };
    })
    .register('sheep:sessions-list', (request) => readSessions(request.limit))
    .register('sheep:session-create', (request) => {
      const store = getStore();
      const sessionId = randomUUID();

      // Both events land in one transaction with the projection they feed, so
      // the reply below cannot describe a state the log does not yet contain.
      store.record([
        domainEvent('session.created', {
          sessionId,
          title: request.title,
          question: request.question,
        }),
        domainEvent('session.budget-set', {
          sessionId,
          capUsd: store.settings.get('budget.defaultCapUsd'),
        }),
      ]);

      return { sessionId, ...readSessions() };
    })
    .register('sheep:connections-list', () => readConnections())
    .register('sheep:connection-create', async (request) => {
      const connection = await createConnection({
        label: request.label,
        config: request.config,
        ...(request.secret === undefined ? {} : { secret: request.secret }),
        ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
      });
      return { connectionId: connection.connectionId, ...readConnections() };
    })
    .register('sheep:connection-update', async (request) => {
      await updateConnection({
        connectionId: request.connectionId,
        ...(request.label === undefined ? {} : { label: request.label }),
        ...(request.config === undefined ? {} : { config: request.config }),
        ...(request.secret === undefined ? {} : { secret: request.secret }),
        ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
      });
      return readConnections();
    })
    .register('sheep:connection-delete', async (request) => {
      const removed = await deleteConnection(request.connectionId);
      return { removed, ...readConnections() };
    })
    .register('sheep:connection-test', async (request) => {
      const connection = await testConnection(request.connectionId);
      return { connection, ...readConnections() };
    })
    .register('sheep:connection-sign-in', async (request) => {
      const connection = await signInConnection(request.connectionId);
      return { connection, ...readConnections() };
    })
    .register('sheep:local-providers-detect', async () => ({
      providers: (await detectLocal()).map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        baseUrl: provider.baseUrl,
        status: provider.status,
        models: [...provider.models],
        install: provider.install,
        ...(provider.detail === undefined ? {} : { detail: provider.detail }),
      })),
    }));
}

/**
 * The connection list, plus where secrets go on this machine.
 *
 * Returned by every connection write as well as the read, so the renderer never
 * merges a partial reply into its own copy — what it renders is what main just
 * read back out of the database.
 */
function readConnections(): {
  connections: Connection[];
  vaultBackend: ReturnType<typeof getVault>['backend'];
  vaultDescription: string;
} {
  const vault = getVault();
  return {
    connections: getStore().connections.list(),
    vaultBackend: vault.backend,
    vaultDescription: vault.description,
  };
}

/** The projected session list, with how far the projection has replayed. */
function readSessions(limit?: number): {
  sessions: ReturnType<typeof listSessions>;
  projectedThroughSeq: number;
} {
  const store = getStore();
  const status = store.projections.status().find((entry) => entry.name === 'sessions');
  return {
    sessions: limit === undefined ? listSessions(store.db) : listSessions(store.db, limit),
    projectedThroughSeq: status?.lastSeq ?? 0,
  };
}

/**
 * Attaches the registry to Electron's IPC. Only channels with a handler are
 * bound, so anything else the renderer sends has no listener at all.
 */
export function bindIpcRegistry(registry: IpcRegistry): void {
  const missing = registry.missingChannels();
  if (missing.length > 0) {
    throw new Error(`IPC channels declared but not handled: ${missing.join(', ')}`);
  }

  for (const channel of registry.registeredChannels()) {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      try {
        return await registry.dispatch(channel, payload, { senderId: event.sender.id });
      } catch (error) {
        // Electron flattens rejections to a string; keep the code readable.
        throw error instanceof IpcError
          ? new Error(`${error.code}: ${error.message}`)
          : new Error(`IPC_HANDLER_FAILED: ${channel}`, { cause: error });
      }
    });
  }
}

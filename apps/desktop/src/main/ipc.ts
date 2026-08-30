import { randomUUID } from 'node:crypto';
import { app, ipcMain } from 'electron';
import { domainEvent, type Connection, type RosterEntry, type SessionSummary } from '@sheep/core';
import type { ModelDescriptor } from '@sheep/gateway';
import { IpcError, IpcRegistry } from '@sheep/ipc';
import { getSession, listParticipants, listSessions } from '@sheep/store';
import { APP_NAME } from '../shared/product';
import {
  createConnection,
  deleteConnection,
  detectLocal,
  getAdapterRegistry,
  listAvailableModels,
  signInConnection,
  syncConnections,
  testConnection,
  updateConnection,
} from './connections';
import { getVault } from './credentials';
import { logError } from './log';
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
    .register('sheep:session-get', (request) => readSessionDetail(request.sessionId))
    .register('sheep:session-budget-set', (request) => {
      getStore().record([
        domainEvent('session.budget-set', {
          sessionId: request.sessionId,
          capUsd: request.capUsd,
        }),
      ]);
      return readSessionDetail(request.sessionId);
    })
    .register('sheep:roster-attach', async (request) => {
      const store = getStore();
      const connection = store.connections.get(request.connectionId);
      if (!connection) throw new Error(`unknown connection: ${request.connectionId}`);

      // The model is confirmed to exist on that connection before anything is
      // written down: a roster entry naming a model the provider does not serve
      // is a failure that would only surface at the first call.
      const descriptor = await describeModel(connection.adapterId, request.modelId);
      const participantId = randomUUID();

      store.record([
        domainEvent('roster.model-attached', {
          sessionId: request.sessionId,
          participantId,
          model: {
            connectionId: connection.connectionId,
            vendorId: descriptor.vendorId,
            modelId: descriptor.modelId,
          },
          weight: request.weight,
          ...(request.budgetCapUsd === null ? {} : { budgetCapUsd: request.budgetCapUsd }),
          ...(request.preferredRole === null ? {} : { preferredRole: request.preferredRole }),
        }),
      ]);

      return { participantId, ...readSessionDetail(request.sessionId) };
    })
    .register('sheep:roster-reconfigure', (request) => {
      getStore().record([
        domainEvent('roster.model-reconfigured', {
          sessionId: request.sessionId,
          participantId: request.participantId,
          weight: request.weight,
          ...(request.budgetCapUsd === null ? {} : { budgetCapUsd: request.budgetCapUsd }),
          ...(request.preferredRole === null ? {} : { preferredRole: request.preferredRole }),
        }),
      ]);
      return readSessionDetail(request.sessionId);
    })
    .register('sheep:roster-detach', (request) => {
      getStore().record([
        domainEvent('roster.model-detached', {
          sessionId: request.sessionId,
          participantId: request.participantId,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
        }),
      ]);
      return readSessionDetail(request.sessionId);
    })
    .register('sheep:models-list', async (request) => {
      const store = getStore();
      const byAdapter = new Map(
        store.connections.list().map((connection) => [connection.adapterId, connection]),
      );
      const { handles, failures } = await listAvailableModels(
        request.refresh === undefined ? {} : { refresh: request.refresh },
      );

      return {
        models: handles.flatMap((handle) => {
          const connection = byAdapter.get(handle.adapterId);
          if (!connection) return [];
          return [
            {
              connectionId: connection.connectionId,
              connectionLabel: connection.label,
              adapterId: handle.adapterId,
              vendorId: handle.descriptor.vendorId,
              modelId: handle.descriptor.modelId,
              displayName: handle.descriptor.displayName,
              contextWindowTokens: handle.descriptor.contextWindowTokens,
              maxOutputTokens: handle.descriptor.maxOutputTokens,
              local: handle.descriptor.local,
              inputPerMTokUsd: handle.descriptor.pricing?.inputPerMTokUsd ?? null,
              outputPerMTokUsd: handle.descriptor.pricing?.outputPerMTokUsd ?? null,
            },
          ];
        }),
        failures,
      };
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

/**
 * One session and its roster, straight off the projection.
 *
 * Reads after the write in every handler above, so the reply describes the
 * state the log actually produced rather than the state the caller asked for.
 */
function readSessionDetail(sessionId: string): {
  session: SessionSummary;
  roster: RosterEntry[];
  projectedThroughSeq: number;
} {
  const store = getStore();
  const session = getSession(store.db, sessionId);
  if (!session) throw new Error(`unknown session: ${sessionId}`);

  const status = store.projections.status().find((entry) => entry.name === 'sessions');
  return {
    session,
    roster: listParticipants(store.db, sessionId),
    projectedThroughSeq: status?.lastSeq ?? 0,
  };
}

/** Confirms a model exists on a connection, and says so precisely when it does not. */
async function describeModel(adapterId: string, modelId: string): Promise<ModelDescriptor> {
  await syncConnections();
  const registry = getAdapterRegistry();
  if (!registry.has(adapterId)) {
    throw new Error(`this connection is not available; test it first`);
  }
  const descriptor = await registry.get(adapterId).describeModel(modelId);
  if (!descriptor) throw new Error(`this connection does not serve model: ${modelId}`);
  return descriptor;
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
        // Electron flattens a rejection to its message, so anything the user
        // needs in order to act has to be *in* the message. A handler failure
        // that reached the renderer as a bare code was a dead end for whoever
        // hit it; the reason travels, and the stack stays here in the log.
        if (error instanceof IpcError) {
          throw new Error(`${error.code}: ${error.message}`, { cause: error });
        }

        logError(`ipc handler failed on ${channel} -`, error);
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`IPC_HANDLER_FAILED: ${channel}: ${reason}`, { cause: error });
      }
    });
  }
}

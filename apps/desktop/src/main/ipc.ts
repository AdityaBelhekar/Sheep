import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, ipcMain } from 'electron';
import {
  calibrationScores,
  domainEvent,
  type Connection,
  type RosterEntry,
  type SessionSummary,
} from '@sheep/core';
import type { ModelDescriptor } from '@sheep/gateway';
import type { RunOutcome } from '@sheep/orchestrator';
import { IpcError, IpcRegistry, type IpcResponse } from '@sheep/ipc';
import {
  getMessage,
  getParticipant,
  getSession,
  listMessages,
  listParticipants,
  listSessions,
  readLedger,
} from '@sheep/store';
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
import {
  artifactsStatus,
  createArtifact,
  linkArtifact,
  readArtifactBlob,
  readArtifacts,
  rerenderArtifact,
} from './artifacts';
import { cancelChat, sendChat } from './chat';
import { cancelLabRun, labStatus, readExecutionBlob, readExecutions, startLabRun } from './lab';
import { approveGate, cancelSession, protocolView, runSession } from './orchestrator';
import { getVault } from './credentials';
import { compilePaper, exportPaper, paperTemplates } from './paper';
import { checkDerivation, getDerivationDetail, readDerivations } from './verification';
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
    .register('sheep:messages-list', (request) => ({
      messages: listMessages(getStore().db, request.sessionId, {
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      }),
    }))
    .register('sheep:protocol-state', async (request) => ({
      status: 'idle' as const,
      reason: null,
      detail: 'read from the log',
      state: await protocolView(request.sessionId),
    }))
    .register('sheep:protocol-run', async (request) =>
      toProtocolReply(await runSession(request.sessionId)),
    )
    .register('sheep:protocol-approve', async (request) =>
      toProtocolReply(
        await approveGate(request.sessionId, {
          gate: request.gate,
          decision: request.decision,
          ...(request.selected === undefined ? {} : { selected: request.selected }),
          ...(request.note === undefined ? {} : { note: request.note }),
        }),
      ),
    )
    .register('sheep:protocol-cancel', async (request) => {
      await cancelSession(request.sessionId);
      return {
        status: 'stopped' as const,
        reason: 'cancelled',
        detail: 'the session will stop at the next step',
        state: await protocolView(request.sessionId),
      };
    })
    .register('sheep:ledger-get', (request) => readLedgerDetail(request.sessionId))
    .register('sheep:claim-record', (request) => {
      const claimId = randomUUID();
      // The store checks this against the session's ledger before it appends,
      // so a refused claim throws here with the rule it broke and writes nothing.
      getStore().record([
        domainEvent('claim.recorded', {
          sessionId: request.sessionId,
          claimId,
          claimType: request.claimType,
          statement: request.statement,
          ...(request.support.length === 0 ? {} : { support: request.support }),
        }),
      ]);
      return { claimId, ...readLedgerDetail(request.sessionId) };
    })
    .register('sheep:claim-provenance', (request) => {
      const store = getStore();
      const ledger = readLedger(store.events, request.sessionId);
      const claim = ledger.claim(request.claimId);
      const ancestry = ledger.ancestry(claim.claimId);
      const lineage = new Set([claim.claimId, ...ancestry.map((entry) => entry.claim.claimId)]);
      const disputes = ledger.disputes().filter((dispute) => lineage.has(dispute.claimId));
      const disputeIds = new Set(disputes.map((dispute) => dispute.disputeId));

      return {
        claim,
        author:
          claim.authorParticipantId === null
            ? null
            : (getParticipant(store.db, claim.authorParticipantId) ?? null),
        message: claim.messageId === null ? null : (getMessage(store.db, claim.messageId) ?? null),
        ancestry,
        disputes,
        resolutions: ledger.resolutions().filter((r) => disputeIds.has(r.disputeId)),
      };
    })
    .register('sheep:chat-send', async (request, context) => {
      const window = windowFor(context.senderId);
      return await sendChat(window, request);
    })
    .register('sheep:lab-status', () => labStatus())
    .register('sheep:lab-run', (request, context) =>
      startLabRun(windowFor(context.senderId), request),
    )
    .register('sheep:lab-cancel', (request) => ({ cancelled: cancelLabRun(request.runId) }))
    .register('sheep:executions-list', (request) => readExecutions(request.sessionId))
    .register('sheep:execution-blob', (request) => readExecutionBlob(request))
    .register('sheep:derivation-check', (request) => checkDerivation(request))
    .register('sheep:derivations-list', (request) => readDerivations(request.sessionId))
    .register('sheep:derivation-get', (request) => getDerivationDetail(request.derivationId))
    .register('sheep:artifacts-status', () => artifactsStatus())
    .register('sheep:artifacts-list', (request) => readArtifacts(request.sessionId))
    .register('sheep:artifact-create', async (request) => {
      const created = await createArtifact(request);
      return {
        created: created.map((artifact) => artifact.artifactId),
        ...readArtifacts(request.sessionId),
      };
    })
    .register('sheep:artifact-blob', (request) => readArtifactBlob(request))
    .register('sheep:artifact-rerender', (request) => rerenderArtifact(request.artifactId))
    .register('sheep:artifact-link', (request) => {
      linkArtifact(request.sessionId, request.artifactId, request.claimId);
      return readArtifacts(request.sessionId);
    })
    .register('sheep:paper-templates', () => paperTemplates())
    .register('sheep:paper-compile', (request) => compilePaper(request))
    .register('sheep:paper-export', (request, context) =>
      exportPaper(windowFor(context.senderId), request),
    )
    .register('sheep:chat-cancel', (request) => ({ cancelled: cancelChat(request.runId) }))
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

/** The orchestrator's outcome, flattened onto the wire shape. */
function toProtocolReply(outcome: RunOutcome): {
  status: 'awaiting-approval' | 'stopped' | 'complete' | 'failed';
  reason: string | null;
  detail: string;
  state: RunOutcome['state'];
} {
  return {
    status: outcome.status,
    reason: outcome.reason,
    detail: outcome.detail,
    state: outcome.state,
  };
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

/** A session's ledger, replayed from the log, with what the UI needs beside it. */
function readLedgerDetail(sessionId: string): IpcResponse<'sheep:ledger-get'> {
  const store = getStore();
  if (!getSession(store.db, sessionId)) throw new Error(`unknown session: ${sessionId}`);
  const ledger = readLedger(store.events, sessionId);
  return {
    claims: ledger.claims(),
    disputes: ledger.disputes(),
    resolutions: ledger.resolutions(),
    positions: ledger.positions(),
    movements: ledger.movements(),
    calibration: calibrationScores(ledger),
    roster: listParticipants(store.db, sessionId),
    rejected: ledger.rejected.length,
  };
}

/**
 * The window a call came from.
 *
 * A run streams back to whoever started it, not to whatever window happens to
 * be focused when the first delta lands — so the sender is resolved once, here,
 * and the run holds it for its lifetime.
 */
function windowFor(senderId: number | undefined): BrowserWindow {
  const sender = senderId === undefined ? undefined : BrowserWindow.fromId(senderId);
  const window = sender ?? BrowserWindow.getAllWindows()[0];
  if (!window) throw new Error('there is no window to stream to');
  return window;
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

import { app, ipcMain } from 'electron';
import { IpcError, IpcRegistry } from '@sheep/ipc';
import { APP_NAME } from '../shared/product';
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
    });
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

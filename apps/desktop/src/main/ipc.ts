import { app, ipcMain } from 'electron';
import { IpcError, IpcRegistry } from '@sheep/ipc';
import { APP_NAME } from '../shared/product';

/** Builds the main-process registry with every handler this app serves. */
export function createIpcRegistry(): IpcRegistry {
  return new IpcRegistry().register('sheep:ping', (request) => {
    const receivedAt = Date.now();
    return {
      pong: true as const,
      app: APP_NAME,
      version: app.getVersion(),
      receivedAt,
      elapsedMs: receivedAt - request.sentAt,
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

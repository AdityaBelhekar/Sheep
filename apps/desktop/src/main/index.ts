import { app, BrowserWindow } from 'electron';
import { APP_NAME } from '../shared/product';
import { bindIpcRegistry, createIpcRegistry } from './ipc';
import { applyRendererSecurityPolicy } from './security';
import { beginSmokeRun, expectSmokeCheck, isSmokeRun, recordSmokeCheck } from './smoke';
import { closeStore, openStore } from './store';
import { createMainWindow, rendererDevServerUrl } from './window';

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('dev.sheep.app');

if (isSmokeRun) {
  expectSmokeCheck('store-ready');
  expectSmokeCheck('window-ready');
  expectSmokeCheck('renderer-mounted');
  expectSmokeCheck('ipc-ping');
  expectSmokeCheck('ipc-channel-guard');
  beginSmokeRun((exitCode) => {
    app.exit(exitCode);
  });
}

// One instance owns the local store; a second launch focuses the first window.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });

  void app.whenReady().then(() => {
    applyRendererSecurityPolicy(Boolean(rendererDevServerUrl));

    try {
      openStore();
    } catch (error) {
      // A broken store is worth surfacing loudly, but the window still opens
      // so the failure can be shown rather than the app vanishing.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`sheep: could not open the store - ${message}\n`);
      recordSmokeCheck('store-ready', false, message);
    }

    bindIpcRegistry(createIpcRegistry());
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    closeStore();
  });
}

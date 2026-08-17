import { app, BrowserWindow } from 'electron';
import { APP_NAME } from '../shared/product';
import { openVault, runCredentialSelfTest } from './credentials';
import { bindIpcRegistry, createIpcRegistry } from './ipc';
import { logError } from './log';
import { applyRendererSecurityPolicy } from './security';
import { beginSmokeRun, expectSmokeCheck, isSmokeRun, recordSmokeCheck } from './smoke';
import { closeStore, openStore, recordLaunch } from './store';
import { createMainWindow, rendererDevServerUrl } from './window';

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('dev.sheep.app');

if (isSmokeRun) {
  expectSmokeCheck('store-ready');
  expectSmokeCheck('event-log');
  expectSmokeCheck('projections');
  expectSmokeCheck('credential-vault');
  expectSmokeCheck('credential-isolation');
  expectSmokeCheck('log-redaction');
  expectSmokeCheck('window-ready');
  expectSmokeCheck('renderer-mounted');
  expectSmokeCheck('ipc-ping');
  expectSmokeCheck('ipc-channel-guard');
  expectSmokeCheck('renderer-chain-status');
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

    let storeOpened = false;
    try {
      openStore();
      recordLaunch();
      storeOpened = true;
    } catch (error) {
      // A broken store is worth surfacing loudly, but the window still opens
      // so the failure can be shown rather than the app vanishing.
      const message = error instanceof Error ? error.message : String(error);
      logError('could not open the store -', error);
      for (const check of ['store-ready', 'event-log', 'projections']) {
        recordSmokeCheck(check, false, message);
      }
    }

    openVault();
    if (isSmokeRun) {
      if (storeOpened) {
        void runCredentialSelfTest();
      } else {
        for (const check of ['credential-vault', 'credential-isolation', 'log-redaction']) {
          recordSmokeCheck(check, false, 'the store did not open');
        }
      }
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

import { app, BrowserWindow } from 'electron';
import { APP_NAME } from '../shared/product';
import { applyRendererSecurityPolicy } from './security';
import { beginSmokeRun, expectSmokeCheck, isSmokeRun } from './smoke';
import { createMainWindow, rendererDevServerUrl } from './window';

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('dev.sheep.app');

if (isSmokeRun) {
  expectSmokeCheck('window-ready');
  expectSmokeCheck('renderer-mounted');
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
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { APP_NAME } from '../shared/product';
import { cancelAllChats } from './chat';
import { syncConnections } from './connections';
import { openVault, runCredentialSelfTest } from './credentials';
import { bindIpcRegistry, createIpcRegistry } from './ipc';
import { cancelAllLabRuns } from './lab';
import { logError, logInfo } from './log';
import { startOrchestrator, stopOrchestrator } from './orchestrator';
import { applyRendererSecurityPolicy } from './security';
import { beginSmokeRun, expectSmokeCheck, isSmokeRun, recordSmokeCheck } from './smoke';
import { closeStore, openStore, recordLaunch } from './store';
import { createMainWindow, rendererDevServerUrl } from './window';

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('dev.sheep.app');

let smokeDataDir: string | undefined;

if (isSmokeRun) {
  // A launch check that creates sessions and credentials must not do it in the
  // user's own data directory. A throwaway one also makes every run start from a
  // fresh database, so migrations are exercised from scratch and the counts the
  // checks assert are deterministic.
  smokeDataDir = mkdtempSync(join(tmpdir(), 'sheep-smoke-'));
  app.setPath('userData', smokeDataDir);
  app.setPath('sessionData', smokeDataDir);

  // A launch check must not depend on the window being in front. Occluded, or
  // on a locked screen, Chromium stops animation frames, and the PDF previews
  // are drawn on them: the checks would wait for pages that never paint.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');

  for (const check of [
    'store-ready',
    'event-log',
    'projections',
    'credential-vault',
    'credential-isolation',
    'log-redaction',
    'window-ready',
    'renderer-mounted',
    'ipc-ping',
    'renderer-chain-status',
    'renderer-navigation',
    'renderer-projection',
    'renderer-connections',
    'renderer-roster',
    'renderer-chat',
    'renderer-lab',
    'renderer-verification',
    'artifacts-render',
    'renderer-artifacts',
    'renderer-paper',
    'orchestrator-ready',
    'orchestrator-protocol',
    'stream-cancel',
    'stream-concurrency',
    'renderer-theme',
    'ipc-channel-guard',
  ]) {
    expectSmokeCheck(check);
  }

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

    // Adapters are materialised from the stored connections before the window
    // opens, so the roster has something to offer the moment it is asked.
    if (storeOpened) {
      void syncConnections().catch((error: unknown) => {
        logError('connections could not be synchronised -', error);
      });
    }

    bindIpcRegistry(createIpcRegistry());
    createMainWindow();

    // Spawned eagerly rather than on first use: a session that resumes on
    // launch should not wait for a process to boot, and a spawn failure is
    // worth knowing about before someone presses Run.
    if (storeOpened) {
      void startOrchestrator().catch((error: unknown) => {
        logError('the orchestrator could not start -', error);
        recordSmokeCheck('orchestrator-ready', false, String(error));
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    // Runs are aborted before the store closes: a stream still writing into a
    // closed database would fail at the one moment its partial answer is the
    // only copy that exists.
    cancelAllChats();
    cancelAllLabRuns();
    stopOrchestrator();
    closeStore();
    if (smokeDataDir) {
      rmSync(smokeDataDir, { recursive: true, force: true });
      logInfo(`smoke data directory removed: ${smokeDataDir}`);
    }
  });
}

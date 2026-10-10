import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { IpcResponse } from '@sheep/ipc';
import type { AppUpdater } from 'electron-updater';
import { logError } from './log';
import { isNewer, updatePolicy, type UpdatePolicy } from './update-policy';

/**
 * Updates: looked for when asked, installed when asked, and only ever from a
 * release signed by the publisher of the copy that is running.
 *
 * The updater is electron-updater, pointed at the project's GitHub releases by
 * the file the build writes beside the app. It is loaded only when a person
 * presses the button — a copy that is never asked about updates never loads
 * it and never contacts anything. On Windows it checks the downloaded
 * installer's signature against this build's publisher before it will run it.
 */

/** Whether the build was signed, as packaging recorded it in the app's own package.json. */
function builtSigned(): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
      sheep?: { signed?: unknown };
    };
    return manifest.sheep?.signed === true;
  } catch {
    return false;
  }
}

export function currentUpdatePolicy(): UpdatePolicy {
  return updatePolicy({ packaged: app.isPackaged, signed: builtSigned() });
}

async function updater(): Promise<AppUpdater> {
  const { autoUpdater } = (await import('electron-updater')).default;
  // Nothing happens that was not asked for: no download on finding a release,
  // no install on the way out.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  return autoUpdater;
}

export async function checkForUpdate(): Promise<IpcResponse<'sheep:update-check'>> {
  const current = app.getVersion();
  const policy = currentUpdatePolicy();
  if (!policy.enabled) return { status: 'disabled', current, version: null, detail: policy.reason };

  try {
    const result = await (await updater()).checkForUpdates();
    const version = result?.updateInfo.version ?? null;
    return version !== null && isNewer(version, current)
      ? {
          status: 'available',
          current,
          version,
          detail: `Version ${version} is available. It will be checked against this build's publisher before it is installed.`,
        }
      : {
          status: 'current',
          current,
          version: null,
          detail: `Sheep ${current} is the newest release.`,
        };
  } catch (error) {
    logError('update check failed -', error);
    return {
      status: 'error',
      current,
      version: null,
      detail: `The releases could not be reached: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    };
  }
}

/**
 * Downloads the release found by the last check and restarts into it.
 *
 * The download is verified before this returns; a release that does not carry
 * the publisher's signature is refused by the updater and nothing is run.
 */
export async function installUpdate(): Promise<IpcResponse<'sheep:update-install'>> {
  const policy = currentUpdatePolicy();
  if (!policy.enabled) return { started: false, detail: policy.reason };
  try {
    const autoUpdater = await updater();
    const found = await autoUpdater.checkForUpdates();
    if (!found || !isNewer(found.updateInfo.version, app.getVersion())) {
      return { started: false, detail: 'There is no newer release to install.' };
    }
    await autoUpdater.downloadUpdate();
    // Deferred so this reply reaches the window before the window goes away.
    setImmediate(() => {
      autoUpdater.quitAndInstall(false, true);
    });
    return { started: true, detail: `Installing ${found.updateInfo.version}; Sheep will restart.` };
  } catch (error) {
    logError('update install failed -', error);
    return {
      started: false,
      detail: `The update was not installed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    };
  }
}

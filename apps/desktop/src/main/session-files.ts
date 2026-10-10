import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import type { IpcResponse } from '@sheep/ipc';
import {
  exportSession,
  getSession,
  importSession,
  SESSION_BUNDLE_EXTENSION,
  type ImportedSession,
} from '@sheep/store';
import { isSmokeRun } from './smoke';
import { getStore } from './store';

/**
 * Sessions as files: saving one to a `.sheep` bundle, and opening one.
 *
 * The renderer never names a path. Where a bundle is saved, and which one is
 * opened, is chosen in a dialog main shows — or, for a file the person
 * double-clicked, handed to main by the operating system.
 */

const FILTERS = [{ name: 'Sheep session', extensions: [SESSION_BUNDLE_EXTENSION] }];

/** The largest file that will be read as a bundle. The store refuses more than it unpacks to. */
const MAX_BUNDLE_BYTES = 1_024 * 1_024 * 1_024;

/** Where the launch check's own export went, so that it has something to import. */
let lastSmokeExport: string | undefined;

/** A file name a session's title can safely become. */
const fileNameFor = (title: string, sessionId: string): string =>
  `${
    title
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'session'
  }-${sessionId.slice(0, 8)}.${SESSION_BUNDLE_EXTENSION}`;

export async function exportSessionFile(
  window: BrowserWindow,
  sessionId: string,
): Promise<IpcResponse<'sheep:session-export'>> {
  const store = getStore();
  const session = getSession(store.db, sessionId);
  if (!session) throw new Error(`unknown session: ${sessionId}`);
  const name = fileNameFor(session.title, sessionId);

  // A launch check cannot answer a dialog; it gets the bundle in its own data directory.
  const path = isSmokeRun
    ? join(app.getPath('userData'), name)
    : (
        await dialog.showSaveDialog(window, {
          title: 'Export session',
          defaultPath: join(app.getPath('documents'), name),
          filters: FILTERS,
        })
      ).filePath;
  if (!path) return { saved: false, path: null, bytes: 0 };

  const bundle = exportSession(store, sessionId);
  writeFileSync(path, bundle);
  if (isSmokeRun) lastSmokeExport = path;
  return { saved: true, path, bytes: bundle.byteLength };
}

/** Imports the bundle at a path. Throws, in the bundle's own terms, when it is refused. */
export function importSessionAt(path: string): ImportedSession {
  if (statSync(path).size > MAX_BUNDLE_BYTES) {
    throw new Error('this file is larger than any session bundle');
  }
  return importSession(getStore(), readFileSync(path));
}

export async function importSessionFile(
  window: BrowserWindow,
): Promise<IpcResponse<'sheep:session-import'>> {
  const [path] = isSmokeRun
    ? lastSmokeExport === undefined
      ? []
      : [lastSmokeExport]
    : (
        await dialog.showOpenDialog(window, {
          title: 'Import session',
          properties: ['openFile'],
          filters: FILTERS,
        })
      ).filePaths;
  if (path === undefined) return { imported: null };
  return { imported: importSessionAt(path) };
}

/** The session bundle among a process's arguments, if it was started to open one. */
export function bundleArgument(argv: readonly string[]): string | undefined {
  return argv.find((argument) => argument.toLowerCase().endsWith(`.${SESSION_BUNDLE_EXTENSION}`));
}

/**
 * Opens a bundle the operating system handed over — a double-clicked file.
 *
 * There is no pane to report into at this point, so the outcome is a dialog:
 * what was imported, or why it was not. The window is then reloaded, which is
 * the plainest way to have every pane read the store again.
 */
export async function openBundleFromSystem(window: BrowserWindow, path: string): Promise<void> {
  try {
    const imported = importSessionAt(path);
    await dialog.showMessageBox(window, {
      type: 'info',
      message: `Imported “${imported.title}”`,
      detail: `${String(imported.events)} events and ${String(imported.blobs)} files, checked against their hashes and the ledger's rules.`,
    });
    window.webContents.reload();
  } catch (error) {
    await dialog.showMessageBox(window, {
      type: 'error',
      message: 'This session was not imported',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

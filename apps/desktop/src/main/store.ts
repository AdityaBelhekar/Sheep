import { app } from 'electron';
import { openSheepStore, type SheepStore } from '@sheep/store';
import { recordSmokeCheck } from './smoke';

let store: SheepStore | undefined;

/**
 * Opens the local database under Electron's user data path.
 *
 * The native driver is built against Node's ABI, not Electron's, so on many
 * machines this quietly lands on the WebAssembly driver instead — which is the
 * point of having one. Whatever happens is reported, never assumed.
 */
export function openStore(): SheepStore {
  if (store) return store;

  const opened = openSheepStore({ dataDir: app.getPath('userData') });
  store = opened;

  const detail = [
    opened.driver,
    `journal=${opened.journalMode}`,
    `schema=v${String(opened.schemaVersion)}`,
    opened.migrations.applied.length > 0
      ? `applied=${String(opened.migrations.applied.length)}`
      : 'applied=0',
  ].join(' · ');
  recordSmokeCheck('store-ready', true, detail);

  if (opened.fallbackReason !== undefined) {
    process.stdout.write(`sheep: sqlite fell back to wasm — ${opened.fallbackReason}\n`);
  }
  return opened;
}

export function getStore(): SheepStore {
  if (!store) throw new Error('store: openStore() has not run yet');
  return store;
}

export function closeStore(): void {
  store?.close();
  store = undefined;
}

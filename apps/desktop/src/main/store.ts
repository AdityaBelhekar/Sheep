import { app } from 'electron';
import { EventLog, openSheepStore, type SheepStore } from '@sheep/store';
import { recordSmokeCheck } from './smoke';

let store: SheepStore | undefined;
let eventLog: EventLog | undefined;

/**
 * Opens the local database under Electron's user data path.
 *
 * The native driver is built against Node's ABI, not Electron's, so on some
 * machines this quietly lands on the WebAssembly driver instead — which is the
 * point of having one. Whatever happens is reported, never assumed.
 */
export function openStore(): SheepStore {
  if (store) return store;

  const opened = openSheepStore({ dataDir: app.getPath('userData') });
  store = opened;
  eventLog = new EventLog(opened.db);

  const detail = [
    opened.driver,
    `journal=${opened.journalMode}`,
    `schema=v${String(opened.schemaVersion)}`,
    `applied=${String(opened.migrations.applied.length)}`,
  ].join(' · ');
  recordSmokeCheck('store-ready', true, detail);

  if (opened.fallbackReason !== undefined) {
    process.stdout.write(`sheep: sqlite fell back to wasm - ${opened.fallbackReason}\n`);
  }
  return opened;
}

export function getStore(): SheepStore {
  if (!store) throw new Error('store: openStore() has not run yet');
  return store;
}

export function getEventLog(): EventLog {
  if (!eventLog) throw new Error('store: openStore() has not run yet');
  return eventLog;
}

/**
 * Records this launch in the log, then replays the whole chain and verifies
 * it. Every launch therefore proves the log is intact before anything is
 * built on top of it.
 */
export function recordLaunch(): void {
  const log = getEventLog();
  log.append({
    type: 'app.started',
    payload: {
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions['electron'] ?? 'unknown',
    },
  });

  const verification = log.verify();
  const detail = `entries=${String(log.count())} verified=${String(verification.checked)}${
    verification.ok ? '' : ` failures=${String(verification.failures.length)}`
  }`;
  recordSmokeCheck('event-log', verification.ok, detail);

  if (!verification.ok) {
    for (const failure of verification.failures.slice(0, 5)) {
      process.stderr.write(
        `sheep: event log integrity failure at seq ${String(failure.seq)} - ${failure.reason}: ${failure.detail}\n`,
      );
    }
  }
}

export function closeStore(): void {
  store?.close();
  store = undefined;
  eventLog = undefined;
}

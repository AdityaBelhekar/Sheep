import { app } from 'electron';
import { domainEvent } from '@sheep/core';
import { openSheepStore, type EventLog, type SheepStore } from '@sheep/store';
import { recordSmokeCheck } from './smoke';

let store: SheepStore | undefined;

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

  const detail = [
    opened.driver,
    `journal=${opened.journalMode}`,
    `schema=v${String(opened.schemaVersion)}`,
    `applied=${String(opened.migrations.applied.length)}`,
  ].join(' · ');
  recordSmokeCheck('store-ready', true, detail);
  reportProjections(opened);

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
  return getStore().events;
}

/**
 * Reports what the projections did on open.
 *
 * A rebuild is normal — after an upgrade that changes a projected column, the
 * derived tables are thrown away and replayed — but a payload that failed its
 * schema is not, so those are surfaced rather than counted.
 */
function reportProjections(opened: SheepStore): void {
  const detail = opened.projectionState
    .map((result) => {
      const parts = [result.name, `seq=${String(result.report.lastSeq)}`];
      if (result.created) parts.push('created');
      if (result.rebuilt) parts.push('rebuilt');
      if (result.report.unknown > 0) parts.push(`unknown=${String(result.report.unknown)}`);
      if (result.report.failures.length > 0) {
        parts.push(`failures=${String(result.report.failures.length)}`);
      }
      return parts.join(' ');
    })
    .join(' · ');

  const failures = opened.projectionState.flatMap((result) => result.report.failures);
  for (const failure of failures.slice(0, 5)) {
    process.stderr.write(
      `sheep: projection could not read event ${String(failure.seq)} (${failure.type}) - ${failure.detail}\n`,
    );
  }
  recordSmokeCheck('projections', failures.length === 0, detail);
}

/**
 * Records this launch in the log, then replays the whole chain and verifies
 * it. Every launch therefore proves the log is intact before anything is
 * built on top of it.
 */
export function recordLaunch(): void {
  const current = getStore();

  // Through `record`, so the log entry and the projections it feeds move
  // together — a reader can never see one without the other.
  current.record([
    domainEvent('app.started', {
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions['electron'] ?? 'unknown',
    }),
  ]);

  const log = current.events;
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
}

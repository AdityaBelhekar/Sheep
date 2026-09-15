import { isLedgerEventType, Ledger, safeParseDomainEvent, type LedgerEntry } from '@sheep/core';
import type { AppendEventInput, EventLog } from './events/log';

/**
 * A session's ledger, replayed from the log.
 *
 * Entries this build cannot parse are left out, as the projections do; the
 * ledger's own rule breaks are kept on `rejected`.
 */
export function readLedger(log: EventLog, sessionId: string): Ledger {
  return Ledger.replay(sessionId, ledgerEntries(log, sessionId));
}

function* ledgerEntries(log: EventLog, sessionId: string): Generator<LedgerEntry> {
  for (const record of log.stream({ sessionId })) {
    if (!isLedgerEventType(record.type)) continue;
    const parsed = safeParseDomainEvent(record.type, record.payload);
    if (parsed.ok) yield { event: parsed.event, recordedAt: record.recordedAt };
  }
}

/**
 * Checks every ledger event in a batch against its session's ledger, and throws
 * the first `LedgerError` before anything is appended.
 *
 * Events are applied in batch order to one ledger per session, so a batch that
 * records an execution and then the claim it backs passes as a unit.
 */
export function enforceLedger(log: EventLog, inputs: readonly AppendEventInput[]): void {
  const ledgers = new Map<string, Ledger>();
  const now = new Date().toISOString();

  for (const input of inputs) {
    if (!isLedgerEventType(input.type)) continue;
    // An unreadable claim cannot be checked, so it cannot be recorded.
    const parsed = safeParseDomainEvent(input.type, input.payload);
    if (!parsed.ok) throw parsed.error;

    const sessionId = (parsed.event.payload as { sessionId: string }).sessionId;
    let ledger = ledgers.get(sessionId);
    if (!ledger) {
      // ponytail: replays the session's whole log per write; keep a cached ledger if sessions grow huge
      ledger = readLedger(log, sessionId);
      ledgers.set(sessionId, ledger);
    }
    ledger.apply(parsed.event, now);
  }
}

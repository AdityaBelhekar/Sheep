import { createHash } from 'node:crypto';
import { safeParseDomainEvent, type DomainEvent } from '@sheep/core';
import type { RunCodeRequest, RunCodeResult, SessionSnapshot } from '@sheep/orchestrator';
import type { Sandbox } from '@sheep/sandbox';
import {
  getSession,
  listExecutions,
  listParticipants,
  recordExecution,
  type SheepStore,
} from '@sheep/store';

/**
 * What the orchestrator may ask of the rest of the app, as plain functions.
 *
 * The orchestrator owns no database and no sandbox; main does. These are the
 * operations main performs on its behalf — read a session, append to the log,
 * run a script — written against a store and a sandbox that are handed in.
 * Nothing here knows about Electron, which is deliberate: the end-to-end test
 * drives a whole session through these same functions with no window, no
 * child process and no IPC, so what it proves is what the app does.
 */
export interface ProtocolServices {
  snapshot(sessionId: string): SessionSnapshot;
  record(sessionId: string, events: readonly unknown[]): { recorded: number };
  execute(sessionId: string, request: RunCodeRequest): Promise<RunCodeResult>;
}

export interface ProtocolServiceDeps {
  /** Looked up per call: the store and sandbox are opened lazily, after this is built. */
  readonly store: () => SheepStore;
  readonly sandbox: () => Sandbox;
  /** Told about a log entry this build cannot read. */
  readonly onUnreadable?: (seq: number, reason: string) => void;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function createProtocolServices(deps: ProtocolServiceDeps): ProtocolServices {
  /** This session's events, in chain order, already parsed against the schema. */
  const readEvents = (sessionId: string): DomainEvent[] => {
    const events: DomainEvent[] = [];
    for (const record of deps.store().events.stream({ sessionId })) {
      const parsed = safeParseDomainEvent(record.type, record.payload);
      if (parsed.ok) {
        events.push(parsed.event);
        continue;
      }
      // An entry this build cannot read is skipped rather than fatal — a log
      // written by a newer version must not make the app unopenable — but it
      // is said out loud, because the protocol state it produces is incomplete.
      deps.onUnreadable?.(record.seq, parsed.error.message);
    }
    return events;
  };

  return {
    snapshot(sessionId) {
      const store = deps.store();
      const session = getSession(store.db, sessionId);
      if (!session) throw new Error(`unknown session: ${sessionId}`);
      return {
        sessionId,
        title: session.title,
        question: session.question,
        status: session.status,
        budget: session.budget,
        roster: listParticipants(store.db, sessionId, { attachedOnly: true }),
        events: readEvents(sessionId),
      };
    },

    record(_sessionId, raw) {
      // Parsed here, not trusted: this is the last point before the hash chain,
      // where a malformed payload would be permanent.
      const events = raw.map((entry) => {
        const candidate = entry as { type?: unknown; payload?: unknown };
        const parsed = safeParseDomainEvent(String(candidate.type), candidate.payload);
        if (!parsed.ok) throw parsed.error;
        return { type: parsed.event.type, payload: parsed.event.payload as never };
      });
      deps.store().record(events);
      return { recorded: events.length };
    },

    async execute(sessionId, request) {
      const store = deps.store();
      const sandbox = deps.sandbox();
      const seed = request.seed ?? 0;

      // A clean run of the same code, seed and runtime is the same run: it is
      // seeded and its environment is locked. Returned again rather than
      // repeated, which is what lets a phase re-read a result after a restart.
      const codeHash = sha256(request.code);
      const prior = listExecutions(store.db, sessionId).find(
        (execution) =>
          execution.status === 'ok' &&
          execution.codeHash === codeHash &&
          execution.seed === seed &&
          execution.envLockHash === sandbox.runtime.lockHash,
      );
      if (prior) {
        return {
          execution: prior,
          stdout: store.blobs.readText(prior.stdoutHash),
          stderr: store.blobs.readText(prior.stderrHash),
        };
      }

      const result = await sandbox.run({
        code: request.code,
        seed,
        ...(request.timeoutMs === undefined ? {} : { limits: { timeoutMs: request.timeoutMs } }),
      });
      try {
        const execution = await recordExecution(store, sessionId, request.code, result);
        return { execution, stdout: result.stdout, stderr: result.stderr };
      } finally {
        result.dispose();
      }
    },
  };
}

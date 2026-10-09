import { createHash } from 'node:crypto';
import { safeParseDomainEvent, type DomainEvent } from '@sheep/core';
import { randomUUID } from 'node:crypto';
import type {
  CheckRequest,
  CheckResult,
  RunCodeRequest,
  RunCodeResult,
  SessionSnapshot,
} from '@sheep/orchestrator';
import type { Sandbox } from '@sheep/sandbox';
import {
  getSession,
  listDerivations,
  listExecutions,
  listParticipants,
  readDerivation,
  recordDerivation,
  recordExecution,
  type SheepStore,
} from '@sheep/store';
import { Verifier } from '@sheep/verify';

/**
 * What the orchestrator may ask of the rest of the app, as plain functions.
 *
 * The orchestrator owns no database and no sandbox; main does. These are the
 * operations main performs on its behalf — read a session, append to the log,
 * run a script, hand something to a checker — written against a store and a sandbox that are handed in.
 * Nothing here knows about Electron, which is deliberate: the end-to-end test
 * drives a whole session through these same functions with no window, no
 * child process and no IPC, so what it proves is what the app does.
 */
export interface ProtocolServices {
  snapshot(sessionId: string): SessionSnapshot;
  record(sessionId: string, events: readonly unknown[]): { recorded: number };
  execute(sessionId: string, request: RunCodeRequest): Promise<RunCodeResult>;
  check(sessionId: string, request: CheckRequest): Promise<CheckResult>;
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

    async check(sessionId, request) {
      const store = deps.store();
      const sandbox = deps.sandbox();
      const verifier = new Verifier(sandbox);
      /** A verdict that has no record of its own is kept as a blob the session holds. */
      const keep = (verdict: unknown): CheckResult['evidence'] => ({
        kind: 'ARTIFACT',
        ref: store.blobs.put(JSON.stringify(verdict), { kind: 'session-check', id: sessionId })
          .hash,
      });

      if (request.kind === 'derivation') {
        // The same derivation checked by the same runtime is the same check.
        const bodyHash = sha256(JSON.stringify(request.derivation));
        const prior = listDerivations(store.db, sessionId).find(
          (record) =>
            record.bodyHash === bodyHash && record.envLockHash === sandbox.runtime.lockHash,
        );
        const detail =
          (prior && readDerivation(store, prior.derivationId)) ??
          (await (async () => {
            const [verdict] = await verifier.checkDerivations([request.derivation]);
            if (!verdict) throw new Error('the checker returned no verdict');
            const record = recordDerivation(store, {
              sessionId,
              derivationId: randomUUID(),
              derivation: request.derivation,
              verdict,
              envLockHash: sandbox.runtime.lockHash,
            });
            return { record, verdict };
          })());
        const { record, verdict } = detail;
        const worst = verdict.steps.find((step) => step.status === verdict.status);
        return {
          status: verdict.status,
          detail:
            `${String(verdict.counts.pass)} step(s) pass, ${String(verdict.counts.fail)} fail, ${String(verdict.counts.uncheckable)} uncheckable` +
            (verdict.status === 'PASS' || !worst ? '' : `; ${worst.id}: ${worst.reason}`),
          // The verdict itself, not the derivation id: a failed derivation is
          // exactly what a dispute may need to cite, and it cannot back a claim.
          evidence: {
            kind: 'ARTIFACT',
            ref: record.verdictHash,
            note: `derivation ${record.derivationId}`,
          },
        };
      }

      if (request.kind === 'constraint') {
        const [verdict] = await verifier.checkConstraints([request.claim]);
        if (!verdict) throw new Error('the checker returned no verdict');
        return { status: verdict.status, detail: verdict.reason, evidence: keep(verdict) };
      }

      const [audit] = await verifier.auditStatistics([request.report]);
      if (!audit) throw new Error('the audit returned no result');
      const notable = audit.findings.filter((finding) => finding.status === audit.status);
      return {
        status: audit.status,
        detail:
          audit.status === 'PASS'
            ? 'every check in the audit passed'
            : notable.map((finding) => `${finding.check}: ${finding.reason}`).join('; '),
        evidence: keep(audit),
      };
    },
  };
}

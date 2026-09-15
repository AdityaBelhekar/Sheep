import {
  canEstablishAlone,
  REQUIRED_EVIDENCE_KIND,
  type Claim,
  type ClaimStatus,
  type ClaimType,
  type EvidenceRef,
} from './claim';
import type { Dispute, Resolution } from './dispute';
import type { DomainEvent, DomainEventType } from './events';

/**
 * The claim ledger: claims, evidence, disputes and resolutions, folded out of
 * the event log and checked as they go.
 *
 * Same shape of idea as the protocol state machine — the log is the record and
 * this is a replay of it — with one difference that matters: the ledger
 * *refuses* events. `apply` validates before it mutates, so a caller can check
 * a batch against the current ledger and append only if every event passes,
 * and a rule broken here is broken before it can reach the hash chain.
 *
 * A claim's status is derived, never stored. Disputes move it; nothing else
 * may say a claim is disputed, refuted or unresolved, because each of those is
 * a statement about evidence and must be backed by the dispute that produced
 * it. Precedence, strongest first: withdrawn, refuted, disputed, unresolved,
 * then whatever the claim's own status events last said.
 *
 * Claim types are enforced here too (P2). An `EMPIRICAL` claim must point at a
 * recorded execution that exited cleanly, a `DERIVED` claim at a recorded
 * derivation, a `CITED` claim at a citation — at the moment it is recorded,
 * not eventually. `CITED` and `CONJECTURE` claims may support others but can
 * never be marked supported themselves: they cannot establish anything alone.
 */

export const LEDGER_EVENT_TYPES = [
  'execution.recorded',
  'derivation.recorded',
  'claim.recorded',
  'claim.evidence-attached',
  'claim.status-changed',
  'dispute.opened',
  'dispute.resolved',
  'dispute.withdrawn',
] as const satisfies readonly DomainEventType[];

const LEDGER_TYPES: ReadonlySet<string> = new Set(LEDGER_EVENT_TYPES);

export function isLedgerEventType(type: string): boolean {
  return LEDGER_TYPES.has(type);
}

export const LEDGER_ERROR_CODES = [
  'CROSS_SESSION',
  'DUPLICATE_CLAIM',
  'UNKNOWN_CLAIM',
  'CLAIM_CLOSED',
  'STATUS_NEEDS_DISPUTE',
  'OPEN_DISPUTES',
  'DUPLICATE_DISPUTE',
  'UNKNOWN_DISPUTE',
  'DISPUTE_CLOSED',
  'RESOLUTION_WITHOUT_EVIDENCE',
  'UNRESOLVED_WITHOUT_POSITIONS',
  'DUPLICATE_EXECUTION',
  'DUPLICATE_DERIVATION',
  'EMPIRICAL_WITHOUT_EXECUTION',
  'DERIVED_WITHOUT_DERIVATION',
  'CITED_WITHOUT_CITATION',
  'UNKNOWN_EXECUTION',
  'FAILED_EXECUTION',
  'UNKNOWN_DERIVATION',
  'UNKNOWN_SUPPORTING_CLAIM',
  'SUPPORT_NOT_STANDING',
  'CYCLIC_SUPPORT',
  'CANNOT_ESTABLISH_ALONE',
] as const;
export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(`LEDGER_${code}: ${message}`);
    this.name = 'LedgerError';
  }
}

/** One log entry as the ledger needs it: the event and when it was recorded. */
export interface LedgerEntry {
  readonly event: DomainEvent;
  readonly recordedAt: string;
}

/** What each type's required evidence is called when it is missing. */
const MISSING_EVIDENCE: Readonly<Record<ClaimType, LedgerErrorCode | null>> = {
  EMPIRICAL: 'EMPIRICAL_WITHOUT_EXECUTION',
  DERIVED: 'DERIVED_WITHOUT_DERIVATION',
  CITED: 'CITED_WITHOUT_CITATION',
  CONJECTURE: null,
};

/** Statuses only a dispute may produce. */
const DISPUTE_STATUSES: ReadonlySet<ClaimStatus> = new Set(['disputed', 'refuted', 'unresolved']);

interface ClaimRecord {
  claim: Omit<Claim, 'status'>;
  /** The last status a `claim.status-changed` set: asserted, supported or withdrawn. */
  own: ClaimStatus;
}

export class Ledger {
  readonly sessionId: string;
  readonly #claims = new Map<string, ClaimRecord>();
  readonly #disputes = new Map<string, Dispute>();
  readonly #resolutions = new Map<string, Resolution>();
  /** Execution id → exit code. */
  readonly #executions = new Map<string, number>();
  readonly #derivations = new Set<string>();
  readonly #rejected: { entry: LedgerEntry; error: LedgerError }[] = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Rebuilds a session's ledger from its log.
   *
   * Lenient where `apply` is strict: an entry that breaks a rule is skipped and
   * kept in `rejected` rather than thrown. Every write path checks first, so a
   * rejected entry means something bypassed that check — worth showing, not
   * worth making the session unreadable over.
   */
  static replay(sessionId: string, entries: Iterable<LedgerEntry>): Ledger {
    const ledger = new Ledger(sessionId);
    for (const entry of entries) {
      if (!isLedgerEventType(entry.event.type)) continue;
      try {
        ledger.apply(entry.event, entry.recordedAt);
      } catch (error) {
        if (!(error instanceof LedgerError)) throw error;
        ledger.#rejected.push({ entry, error });
      }
    }
    return ledger;
  }

  get rejected(): readonly { entry: LedgerEntry; error: LedgerError }[] {
    return this.#rejected;
  }

  claims(): Claim[] {
    return [...this.#claims.keys()].map((id) => this.claim(id));
  }

  claim(claimId: string): Claim {
    const record = this.#claims.get(claimId);
    if (!record) throw new LedgerError('UNKNOWN_CLAIM', `no claim ${claimId} in this session`);
    return { ...record.claim, status: this.#statusOf(claimId, record) };
  }

  hasClaim(claimId: string): boolean {
    return this.#claims.has(claimId);
  }

  disputes(): Dispute[] {
    return [...this.#disputes.values()];
  }

  disputesOf(claimId: string): Dispute[] {
    return this.disputes().filter((dispute) => dispute.claimId === claimId);
  }

  resolutions(): Resolution[] {
    return [...this.#resolutions.values()];
  }

  /** Throws a `LedgerError` and changes nothing if the event breaks a rule. */
  apply(event: DomainEvent, at: string): void {
    if (!isLedgerEventType(event.type)) return;
    const { sessionId } = event.payload as { sessionId: string };
    if (sessionId !== this.sessionId) {
      throw new LedgerError(
        'CROSS_SESSION',
        `event for session ${sessionId} applied to ${this.sessionId}`,
      );
    }

    switch (event.type) {
      case 'execution.recorded': {
        const { executionId, exitCode } = event.payload;
        if (this.#executions.has(executionId)) {
          throw new LedgerError(
            'DUPLICATE_EXECUTION',
            `execution ${executionId} is already recorded`,
          );
        }
        this.#executions.set(executionId, exitCode);
        return;
      }

      case 'derivation.recorded': {
        const { derivationId } = event.payload;
        if (this.#derivations.has(derivationId)) {
          throw new LedgerError(
            'DUPLICATE_DERIVATION',
            `derivation ${derivationId} is already recorded`,
          );
        }
        this.#derivations.add(derivationId);
        return;
      }

      case 'claim.recorded': {
        const p = event.payload;
        if (this.#claims.has(p.claimId)) {
          throw new LedgerError('DUPLICATE_CLAIM', `claim ${p.claimId} is already recorded`);
        }
        const support = p.support ?? [];
        for (const evidence of support) this.#checkEvidence(evidence, p.claimId);
        const required = REQUIRED_EVIDENCE_KIND[p.claimType];
        const missing = MISSING_EVIDENCE[p.claimType];
        if (required !== null && missing !== null && !support.some((e) => e.kind === required)) {
          throw new LedgerError(
            missing,
            `a ${p.claimType} claim must point at a recorded ${required.toLowerCase()} when it is recorded`,
          );
        }
        this.#claims.set(p.claimId, {
          claim: {
            claimId: p.claimId,
            sessionId: p.sessionId,
            phaseId: p.phaseId ?? null,
            messageId: p.messageId ?? null,
            authorParticipantId: p.authorParticipantId ?? null,
            claimType: p.claimType,
            statement: p.statement,
            confidence: p.confidence ?? null,
            support: [...(p.support ?? [])],
            recordedAt: at,
            updatedAt: at,
          },
          own: 'asserted',
        });
        return;
      }

      case 'claim.evidence-attached': {
        const record = this.#open(event.payload.claimId);
        this.#checkEvidence(event.payload.evidence, event.payload.claimId);
        record.claim = {
          ...record.claim,
          support: [...record.claim.support, event.payload.evidence],
          updatedAt: at,
        };
        return;
      }

      case 'claim.status-changed': {
        const { claimId, status } = event.payload;
        const record = this.#open(claimId);
        if (DISPUTE_STATUSES.has(status)) {
          throw new LedgerError(
            'STATUS_NEEDS_DISPUTE',
            `a claim becomes ${status} only through a dispute, never by assertion`,
          );
        }
        if (status === 'supported' && !canEstablishAlone(record.claim.claimType)) {
          throw new LedgerError(
            'CANNOT_ESTABLISH_ALONE',
            `a ${record.claim.claimType} claim can support others but is never established by itself`,
          );
        }
        if (status === 'supported' && this.#openDisputes(claimId) > 0) {
          throw new LedgerError(
            'OPEN_DISPUTES',
            `claim ${claimId} cannot be supported while ${String(this.#openDisputes(claimId))} dispute(s) are open`,
          );
        }
        record.own = status;
        record.claim = { ...record.claim, updatedAt: at };
        return;
      }

      case 'dispute.opened': {
        const p = event.payload;
        if (this.#disputes.has(p.disputeId)) {
          throw new LedgerError('DUPLICATE_DISPUTE', `dispute ${p.disputeId} is already open`);
        }
        const record = this.#open(p.claimId);
        this.#disputes.set(p.disputeId, {
          disputeId: p.disputeId,
          sessionId: p.sessionId,
          claimId: p.claimId,
          raisedByParticipantId: p.raisedByParticipantId ?? null,
          axis: p.axis,
          severity: p.severity,
          argument: p.argument,
          proposedTest: p.proposedTest ?? null,
          status: 'open',
          openedAt: at,
          resolvedAt: null,
        });
        record.claim = { ...record.claim, updatedAt: at };
        return;
      }

      case 'dispute.resolved': {
        const p = event.payload;
        const dispute = this.#openDispute(p.disputeId);
        const positions = p.positions ?? [];
        for (const evidence of p.evidence) this.#checkEvidence(evidence, dispute.claimId);

        if (p.outcome === 'UNRESOLVED') {
          // P6: an open question ships with both sides, or it is not one.
          const sides = new Set(positions.map((position) => position.stance));
          if (!sides.has('SUPPORT') || !sides.has('OPPOSE')) {
            throw new LedgerError(
              'UNRESOLVED_WITHOUT_POSITIONS',
              'an UNRESOLVED dispute must preserve at least one SUPPORT and one OPPOSE position',
            );
          }
        } else if (!p.evidence.some((evidence) => evidence.kind !== 'ARGUMENT')) {
          // The referee writes the rationale; evidence is what decides.
          throw new LedgerError(
            'RESOLUTION_WITHOUT_EVIDENCE',
            `${p.outcome} needs evidence beyond argument — a rationale alone cannot settle a dispute`,
          );
        }

        this.#disputes.set(p.disputeId, {
          ...dispute,
          status: p.outcome === 'UNRESOLVED' ? 'unresolved' : 'resolved',
          resolvedAt: at,
        });
        this.#resolutions.set(p.disputeId, {
          disputeId: p.disputeId,
          outcome: p.outcome,
          rationale: p.rationale,
          evidence: [...p.evidence],
          resolvedByParticipantId: p.resolvedByParticipantId ?? null,
          positions: [...positions],
          resolvedAt: at,
        });
        this.#touch(dispute.claimId, at);
        return;
      }

      case 'dispute.withdrawn': {
        const dispute = this.#openDispute(event.payload.disputeId);
        this.#disputes.set(dispute.disputeId, { ...dispute, status: 'withdrawn', resolvedAt: at });
        this.#touch(dispute.claimId, at);
        return;
      }
    }
  }

  /**
   * Evidence must point at something that exists, in this session, and still
   * stands. `CITATION`, `ARTIFACT` and `ARGUMENT` refs have no record here to
   * check against yet — retrieval records and artifact links arrive in later
   * stages — so only their shape is checked, by the schema.
   */
  #checkEvidence(evidence: EvidenceRef, claimId: string): void {
    switch (evidence.kind) {
      case 'EXECUTION': {
        const exitCode = this.#executions.get(evidence.ref);
        if (exitCode === undefined) {
          throw new LedgerError('UNKNOWN_EXECUTION', `no execution ${evidence.ref} was recorded`);
        }
        if (exitCode !== 0) {
          throw new LedgerError(
            'FAILED_EXECUTION',
            `execution ${evidence.ref} exited with code ${String(exitCode)}; a failed run backs nothing`,
          );
        }
        return;
      }
      case 'DERIVATION': {
        if (!this.#derivations.has(evidence.ref)) {
          throw new LedgerError('UNKNOWN_DERIVATION', `no derivation ${evidence.ref} was recorded`);
        }
        return;
      }
      case 'CLAIM': {
        if (evidence.ref === claimId || this.#supportReaches(evidence.ref, claimId)) {
          throw new LedgerError(
            'CYCLIC_SUPPORT',
            `claim ${claimId} would end up supporting itself`,
          );
        }
        const record = this.#claims.get(evidence.ref);
        if (!record) {
          throw new LedgerError('UNKNOWN_SUPPORTING_CLAIM', `no claim ${evidence.ref} to rest on`);
        }
        const status = this.#statusOf(evidence.ref, record);
        if (status === 'refuted' || status === 'withdrawn') {
          throw new LedgerError(
            'SUPPORT_NOT_STANDING',
            `claim ${evidence.ref} is ${status} and cannot support anything`,
          );
        }
        return;
      }
      default:
        return;
    }
  }

  /** Whether `target` is anywhere in `from`'s chain of supporting claims. */
  #supportReaches(from: string, target: string, seen = new Set<string>()): boolean {
    if (seen.has(from)) return false;
    seen.add(from);
    for (const evidence of this.#claims.get(from)?.claim.support ?? []) {
      if (evidence.kind !== 'CLAIM') continue;
      if (evidence.ref === target || this.#supportReaches(evidence.ref, target, seen)) return true;
    }
    return false;
  }

  #statusOf(claimId: string, record: ClaimRecord): ClaimStatus {
    if (record.own === 'withdrawn') return 'withdrawn';
    const outcomes = this.disputesOf(claimId).map(
      (dispute) => this.#resolutions.get(dispute.disputeId)?.outcome,
    );
    if (outcomes.includes('OVERTURNED')) return 'refuted';
    if (this.#openDisputes(claimId) > 0) return 'disputed';
    if (outcomes.includes('UNRESOLVED')) return 'unresolved';
    return record.own;
  }

  #openDisputes(claimId: string): number {
    return this.disputesOf(claimId).filter((dispute) => dispute.status === 'open').length;
  }

  /** A claim that can still change: recorded, not withdrawn, not refuted. */
  #open(claimId: string): ClaimRecord {
    const record = this.#claims.get(claimId);
    if (!record) throw new LedgerError('UNKNOWN_CLAIM', `no claim ${claimId} in this session`);
    const status = this.#statusOf(claimId, record);
    if (status === 'withdrawn' || status === 'refuted') {
      throw new LedgerError('CLAIM_CLOSED', `claim ${claimId} is ${status}`);
    }
    return record;
  }

  #openDispute(disputeId: string): Dispute {
    const dispute = this.#disputes.get(disputeId);
    if (!dispute) throw new LedgerError('UNKNOWN_DISPUTE', `no dispute ${disputeId}`);
    if (dispute.status !== 'open') {
      throw new LedgerError('DISPUTE_CLOSED', `dispute ${disputeId} is already ${dispute.status}`);
    }
    return dispute;
  }

  #touch(claimId: string, at: string): void {
    const record = this.#claims.get(claimId);
    if (record) record.claim = { ...record.claim, updatedAt: at };
  }
}

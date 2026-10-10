import {
  canEstablishAlone,
  REQUIRED_EVIDENCE_KIND,
  type Claim,
  type ClaimStatus,
  type ClaimType,
  type EvidenceRef,
} from './claim';
import type { VerificationStatus } from './derivation';
import type { Dispute, Resolution } from './dispute';
import type { Position } from './protocol';
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
 * derivation with no step that fails its check, a `CITED` claim at a citation — at the moment it is recorded,
 * not eventually. `CITED` and `CONJECTURE` claims may support others but can
 * never be marked supported themselves: they cannot establish anything alone.
 *
 * Positions are commit-then-reveal (Phase 32). A commitment is a hash of the
 * position; the reveal must match it, and once any reveal for a round and claim
 * exists no one may commit to it, so nobody's stance can be shaped by another's.
 * Hashing needs a digest, which `@sheep/core` does not carry — the renderer
 * imports this package — so the caller passes one, and without it reveals are
 * checked for order but not content.
 */

const CONTENT_ADDRESS = /^[0-9a-f]{64}$/;

export const LEDGER_EVENT_TYPES = [
  'execution.recorded',
  'derivation.recorded',
  'artifact.recorded',
  'claim.recorded',
  'claim.evidence-attached',
  'claim.status-changed',
  'dispute.opened',
  'dispute.tested',
  'dispute.resolved',
  'dispute.withdrawn',
  'position.committed',
  'position.revealed',
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
  'RESOLUTION_CONTRADICTS_TEST',
  'DUPLICATE_TEST',
  'INCONSISTENT_TEST',
  'UNRESOLVED_WITHOUT_POSITIONS',
  'DUPLICATE_EXECUTION',
  'INCONSISTENT_EXECUTION',
  'DUPLICATE_DERIVATION',
  'INCONSISTENT_DERIVATION',
  'FAILED_DERIVATION',
  'DUPLICATE_ARTIFACT',
  'UNKNOWN_ARTIFACT',
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
  'DUPLICATE_COMMITMENT',
  'COMMIT_AFTER_REVEAL',
  'REVEAL_WITHOUT_COMMITMENT',
  'DUPLICATE_REVEAL',
  'REVEAL_MISMATCH',
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

export interface LedgerOptions {
  /** Lower-case hex SHA-256 of a UTF-8 string. Enables reveal verification. */
  readonly digest?: (text: string) => string;
}

/**
 * The exact text a position commitment hashes.
 *
 * Round and claim are inside the hash so a commitment cannot be replayed onto a
 * different question.
 */
export function commitmentPreimage(
  roundId: string,
  claimId: string,
  position: Position,
  salt: string,
): string {
  return JSON.stringify([
    roundId,
    claimId,
    position.participantId,
    position.stance,
    position.confidence,
    position.rationale ?? null,
    salt,
  ]);
}

export interface RevealedPosition {
  readonly roundId: string;
  readonly claimId: string;
  readonly position: Position;
  readonly revealedAt: string;
}

/** How one participant's stance on one claim changed between two reveals. */
export interface PositionMovement {
  readonly claimId: string;
  readonly participantId: string;
  readonly fromRoundId: string;
  readonly toRoundId: string;
  readonly from: Position;
  readonly to: Position;
  readonly stanceChanged: boolean;
  /** `to.confidence - from.confidence`. */
  readonly confidenceDelta: number;
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
  /** Derivation id → the verdict its checker gave it. */
  readonly #derivations = new Map<string, VerificationStatus>();
  readonly #artifacts = new Set<string>();
  /** `round|claim|participant` → commitment hash. */
  readonly #commitments = new Map<string, string>();
  readonly #reveals: RevealedPosition[] = [];
  readonly #rejected: { entry: LedgerEntry; error: LedgerError }[] = [];
  readonly #digest: ((text: string) => string) | undefined;

  constructor(sessionId: string, options: LedgerOptions = {}) {
    this.sessionId = sessionId;
    this.#digest = options.digest;
  }

  /**
   * Rebuilds a session's ledger from its log.
   *
   * Lenient where `apply` is strict: an entry that breaks a rule is skipped and
   * kept in `rejected` rather than thrown. Every write path checks first, so a
   * rejected entry means something bypassed that check — worth showing, not
   * worth making the session unreadable over.
   */
  static replay(
    sessionId: string,
    entries: Iterable<LedgerEntry>,
    options: LedgerOptions = {},
  ): Ledger {
    const ledger = new Ledger(sessionId, options);
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

  /**
   * Every claim a claim rests on, transitively, nearest first.
   *
   * `depth` is how many support steps down the claim sits: 1 is a direct
   * supporting claim. A claim reached by two paths is listed once, at its
   * nearest depth.
   */
  ancestry(claimId: string): { claim: Claim; depth: number }[] {
    const found: { claim: Claim; depth: number }[] = [];
    const seen = new Set([claimId]);
    let frontier = [claimId];
    for (let depth = 1; frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const evidence of this.#claims.get(id)?.claim.support ?? []) {
          if (evidence.kind !== 'CLAIM' || seen.has(evidence.ref)) continue;
          if (!this.#claims.has(evidence.ref)) continue;
          seen.add(evidence.ref);
          found.push({ claim: this.claim(evidence.ref), depth });
          next.push(evidence.ref);
        }
      }
      frontier = next;
    }
    return found;
  }

  /** Every revealed position, in the order revealed. */
  positions(): RevealedPosition[] {
    return [...this.#reveals];
  }

  /**
   * Movement: each participant's consecutive reveals on the same claim, diffed.
   *
   * Measured rather than inferred — both ends are sealed commitments, so a model
   * cannot claim it held a view all along.
   */
  movements(): PositionMovement[] {
    const last = new Map<string, RevealedPosition>();
    const movements: PositionMovement[] = [];
    for (const reveal of this.#reveals) {
      const key = `${reveal.claimId}|${reveal.position.participantId}`;
      const previous = last.get(key);
      if (previous) {
        movements.push({
          claimId: reveal.claimId,
          participantId: reveal.position.participantId,
          fromRoundId: previous.roundId,
          toRoundId: reveal.roundId,
          from: previous.position,
          to: reveal.position,
          stanceChanged: previous.position.stance !== reveal.position.stance,
          confidenceDelta: reveal.position.confidence - previous.position.confidence,
        });
      }
      last.set(key, reveal);
    }
    return movements;
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
        const { executionId, exitCode, status } = event.payload;
        // Backing is decided on the exit code, so the two must tell one story.
        if ((status === 'ok') !== (exitCode === 0)) {
          throw new LedgerError(
            'INCONSISTENT_EXECUTION',
            `execution ${executionId} is recorded as ${status} with exit code ${String(exitCode)}`,
          );
        }
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
        const { derivationId, status, counts } = event.payload;
        // Backing is decided on the status, so it must not contradict the steps.
        if (counts.fail > 0 && status !== 'FAIL') {
          throw new LedgerError(
            'INCONSISTENT_DERIVATION',
            `derivation ${derivationId} is recorded as ${status} with ${String(counts.fail)} failed step(s)`,
          );
        }
        if (this.#derivations.has(derivationId)) {
          throw new LedgerError(
            'DUPLICATE_DERIVATION',
            `derivation ${derivationId} is already recorded`,
          );
        }
        this.#derivations.set(derivationId, status);
        return;
      }

      case 'artifact.recorded': {
        const { artifactId } = event.payload;
        if (this.#artifacts.has(artifactId)) {
          throw new LedgerError('DUPLICATE_ARTIFACT', `artifact ${artifactId} is already recorded`);
        }
        this.#artifacts.add(artifactId);
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
          test: null,
          status: 'open',
          openedAt: at,
          resolvedAt: null,
        });
        record.claim = { ...record.claim, updatedAt: at };
        return;
      }

      case 'dispute.tested': {
        const { sessionId: _session, disputeId, evidence, ...result } = event.payload;
        const dispute = this.#openDispute(disputeId);
        if (dispute.test !== null) {
          throw new LedgerError('DUPLICATE_TEST', `dispute ${disputeId} has already been tested`);
        }
        // An undecided test settles nothing; a decided one settles something.
        if ((result.verdict === 'UNCHECKABLE') !== (result.outcome === 'UNRESOLVED')) {
          throw new LedgerError(
            'INCONSISTENT_TEST',
            `a test with verdict ${result.verdict} cannot leave dispute ${disputeId} ${result.outcome}`,
          );
        }
        if (evidence !== undefined) this.#checkEvidence(evidence, dispute.claimId);
        this.#disputes.set(disputeId, {
          ...dispute,
          test: { ...result, evidence: evidence ?? null },
        });
        this.#touch(dispute.claimId, at);
        return;
      }

      case 'dispute.resolved': {
        const p = event.payload;
        const dispute = this.#openDispute(p.disputeId);
        const positions = p.positions ?? [];
        for (const evidence of p.evidence) this.#checkEvidence(evidence, dispute.claimId);

        // The referee cannot overrule evidence. A test that decided the
        // dispute has decided it; a resolution may explain that, not change it.
        if (dispute.test !== null && dispute.test.outcome !== 'UNRESOLVED') {
          if (p.outcome !== dispute.test.outcome) {
            throw new LedgerError(
              'RESOLUTION_CONTRADICTS_TEST',
              `dispute ${p.disputeId} was tested and came out ${dispute.test.outcome}; it cannot be resolved as ${p.outcome}`,
            );
          }
        }

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

      case 'position.committed': {
        const { roundId, claimId, participantId, commitment } = event.payload;
        if (!this.#claims.has(claimId)) {
          throw new LedgerError('UNKNOWN_CLAIM', `no claim ${claimId} in this session`);
        }
        const key = `${roundId}|${claimId}|${participantId}`;
        if (this.#commitments.has(key)) {
          throw new LedgerError(
            'DUPLICATE_COMMITMENT',
            `participant ${participantId} already committed a position on this claim in this round`,
          );
        }
        if (this.#reveals.some((r) => r.roundId === roundId && r.claimId === claimId)) {
          throw new LedgerError(
            'COMMIT_AFTER_REVEAL',
            'positions on this claim are already being revealed; the round is locked',
          );
        }
        this.#commitments.set(key, commitment);
        return;
      }

      case 'position.revealed': {
        const { roundId, claimId, position, salt } = event.payload;
        const key = `${roundId}|${claimId}|${position.participantId}`;
        const commitment = this.#commitments.get(key);
        if (commitment === undefined) {
          throw new LedgerError(
            'REVEAL_WITHOUT_COMMITMENT',
            `participant ${position.participantId} never committed a position to reveal`,
          );
        }
        if (
          this.#reveals.some(
            (r) =>
              r.roundId === roundId &&
              r.claimId === claimId &&
              r.position.participantId === position.participantId,
          )
        ) {
          throw new LedgerError('DUPLICATE_REVEAL', 'this position has already been revealed');
        }
        if (
          this.#digest !== undefined &&
          this.#digest(commitmentPreimage(roundId, claimId, position, salt)) !== commitment
        ) {
          throw new LedgerError(
            'REVEAL_MISMATCH',
            `participant ${position.participantId} revealed a position other than the one committed`,
          );
        }
        this.#reveals.push({ roundId, claimId, position, revealedAt: at });
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
   * stands. `CITATION` and `ARGUMENT` refs have no record here to check
   * against yet — retrieval records arrive in a later stage — so only their
   * shape is checked, by the schema.
   *
   * An `ARTIFACT` ref is one of two things. A content address names bytes in
   * the store — a checker's stored verdict, say — and is taken as given: the
   * address is its own proof of what it points at. Anything else is the id of
   * a figure, and a claim cannot rest on a figure that was never recorded.
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
        const status = this.#derivations.get(evidence.ref);
        if (status === undefined) {
          throw new LedgerError('UNKNOWN_DERIVATION', `no derivation ${evidence.ref} was recorded`);
        }
        // An UNCHECKABLE derivation may still be cited: it is labelled as what
        // it is wherever it is shown. One with a step that fails may not.
        if (status === 'FAIL') {
          throw new LedgerError(
            'FAILED_DERIVATION',
            `derivation ${evidence.ref} has a step that does not follow; a failed derivation backs nothing`,
          );
        }
        return;
      }
      case 'ARTIFACT': {
        if (!CONTENT_ADDRESS.test(evidence.ref) && !this.#artifacts.has(evidence.ref)) {
          throw new LedgerError('UNKNOWN_ARTIFACT', `no artifact ${evidence.ref} was recorded`);
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

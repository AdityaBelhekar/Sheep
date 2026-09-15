import { createHash, randomBytes } from 'node:crypto';
import { commitmentPreimage, domainEvent, type DomainEvent, type Position } from '@sheep/core';

/**
 * Position locking: every participant's stance on a claim is sealed before any
 * is shown.
 *
 * The two batches this returns are meant to be recorded in order, commitments
 * first. The ledger refuses a commitment once any reveal for that round and
 * claim exists and refuses a reveal that does not hash to its commitment, so a
 * position cannot be quietly revised after seeing someone else's, and movement
 * between rounds is a diff of two sealed values rather than a model's own
 * account of what it used to think.
 */

export interface LockPositionsInput {
  readonly sessionId: string;
  readonly roundId: string;
  readonly claimId: string;
  readonly positions: readonly Position[];
  /** Injected by tests; defaults to 16 random bytes per position. */
  readonly salt?: () => string;
}

export interface LockedPositions {
  readonly commits: readonly DomainEvent[];
  readonly reveals: readonly DomainEvent[];
}

export function commitmentOf(
  roundId: string,
  claimId: string,
  position: Position,
  salt: string,
): string {
  return createHash('sha256')
    .update(commitmentPreimage(roundId, claimId, position, salt), 'utf8')
    .digest('hex');
}

export function lockPositions(input: LockPositionsInput): LockedPositions {
  const salt = input.salt ?? (() => randomBytes(16).toString('hex'));
  const sealed = input.positions.map((position) => ({ position, salt: salt() }));

  return {
    commits: sealed.map(({ position, salt: s }) =>
      domainEvent('position.committed', {
        sessionId: input.sessionId,
        roundId: input.roundId,
        claimId: input.claimId,
        participantId: position.participantId,
        commitment: commitmentOf(input.roundId, input.claimId, position, s),
      }),
    ),
    reveals: sealed.map(({ position, salt: s }) =>
      domainEvent('position.revealed', {
        sessionId: input.sessionId,
        roundId: input.roundId,
        claimId: input.claimId,
        position,
        salt: s,
      }),
    ),
  };
}

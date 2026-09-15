import type { Ledger } from './ledger';

/**
 * Per-participant calibration: how well stated confidence tracked what the
 * evidence later settled.
 *
 * A forecast is a participant's last revealed position on a claim — sealed, so
 * it cannot be rewritten after the fact. `SUPPORT` at confidence c says the
 * claim holds with probability c; `OPPOSE` says 1 − c; `ABSTAIN` says nothing
 * and is not scored. The outcome is decided by disputes: an `OVERTURNED`
 * resolution means the claim did not hold, an `UPHELD` one (with none
 * overturned) means it did, and a claim with neither is not scored at all —
 * an `UNRESOLVED` dispute is not an answer to score against.
 *
 * Brier score is the mean squared error of those probabilities: 0 is perfect,
 * 0.25 is what always saying 0.5 earns. It is shown so a person can weigh a
 * model's confidence; nothing in Sheep reads it to decide anything.
 */

export interface CalibrationScore {
  readonly participantId: string;
  /** Forecasts that met a settled outcome. */
  readonly scored: number;
  /** Null until at least one forecast has been scored. */
  readonly brier: number | null;
}

/** 1 if the evidence upheld the claim, 0 if it overturned it, null if unsettled. */
export function settledOutcome(ledger: Ledger, claimId: string): 0 | 1 | null {
  const outcomes = new Set(
    ledger
      .resolutions()
      .filter((resolution) =>
        ledger.disputesOf(claimId).some((dispute) => dispute.disputeId === resolution.disputeId),
      )
      .map((resolution) => resolution.outcome),
  );
  if (outcomes.has('OVERTURNED')) return 0;
  if (outcomes.has('UPHELD')) return 1;
  return null;
}

export function calibrationScores(ledger: Ledger): CalibrationScore[] {
  // Latest reveal per participant per claim; Map keeps first-seen order.
  const latest = new Map<string, Map<string, { stance: string; confidence: number }>>();
  for (const { claimId, position } of ledger.positions()) {
    const byClaim = latest.get(position.participantId) ?? new Map();
    byClaim.set(claimId, position);
    latest.set(position.participantId, byClaim);
  }

  return [...latest].map(([participantId, byClaim]) => {
    let scored = 0;
    let total = 0;
    for (const [claimId, position] of byClaim) {
      if (position.stance === 'ABSTAIN') continue;
      const outcome = settledOutcome(ledger, claimId);
      if (outcome === null) continue;
      const p = position.stance === 'SUPPORT' ? position.confidence : 1 - position.confidence;
      total += (p - outcome) ** 2;
      scored += 1;
    }
    return { participantId, scored, brier: scored === 0 ? null : total / scored };
  });
}

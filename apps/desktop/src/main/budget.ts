import type { RosterEntry } from '@sheep/core';
import { BudgetExceededError, roundUsd } from '@sheep/gateway';

/**
 * Refuses a call that would take the session, or this model, past its cap.
 *
 * Enforced against the projection rather than an in-memory counter: the
 * projection is where spend is authoritative, and a second accumulator would
 * eventually disagree with it — silently, and in the direction of overspending.
 *
 * Shared by the chat surface and the orchestrator because there must be exactly
 * one place that decides whether a call may happen. Two copies of this rule
 * would mean a cap that held for one path and leaked on the other, and the
 * leaking path would be the autonomous one.
 */
export function assertWithinCaps(
  budget: { capUsd: number | null; spentUsd: number },
  participant: RosterEntry,
  estimatedCostUsd: number | null,
  unpriced: boolean,
): void {
  if (budget.capUsd === null) return;

  // A call whose cost cannot be predicted cannot be kept inside a budget, and
  // counting it as zero is how a cap gets passed without anyone noticing.
  if (unpriced) {
    throw new Error(
      'this model has no price on file, so it cannot run under a session cap; ' +
        'clear the cap or use a model with published pricing',
    );
  }

  const cost = estimatedCostUsd ?? 0;
  if (roundUsd(budget.spentUsd + cost) > budget.capUsd) {
    throw new BudgetExceededError(participant.sessionId, budget.spentUsd, budget.capUsd, cost);
  }
  if (participant.budgetCapUsd !== null && roundUsd(cost) > participant.budgetCapUsd) {
    throw new BudgetExceededError(participant.participantId, 0, participant.budgetCapUsd, cost);
  }
}

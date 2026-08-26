import { tokenCountSchema, usdSchema, type Usage } from '@sheep/core';
import { z } from 'zod';
import type { TokenUsage } from './delta';
import type { ModelDescriptor, ModelPricing } from './descriptor';
import { PricingUnknownError } from './errors';

/** Vendors quote per million tokens; every rate in `ModelPricing` uses this. */
export const TOKENS_PER_PRICING_UNIT = 1_000_000;

/**
 * Sub-cent money is still money.
 *
 * Costs are rounded to a tenth of a microdollar — far below anything billed,
 * but enough to stop floating-point noise from making two identical runs
 * disagree in the ledger.
 */
const USD_DECIMALS = 7;

export function roundUsd(amount: number): number {
  // Via the decimal string, not `Math.round(x / 1e-7) * 1e-7` — that divide and
  // multiply puts back the very floating-point dust it is meant to remove.
  return Number(amount.toFixed(USD_DECIMALS));
}

/**
 * Where a number came from.
 *
 * `estimated` is a guess made before the call from a token count nobody has
 * confirmed; `measured` is arithmetic on usage the provider reported. The
 * budget governor treats them differently — you may refuse to start a run on an
 * estimate, but you may only bill a measurement — so the two never share a type
 * without saying which they are.
 */
export const COST_BASES = ['estimated', 'measured'] as const;
export type CostBasis = (typeof COST_BASES)[number];
export const costBasisSchema = z.enum(COST_BASES);

export const costEstimateSchema = z.strictObject({
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  cachedInputTokens: tokenCountSchema,
  cacheWriteTokens: tokenCountSchema,
  costUsd: usdSchema,
  basis: costBasisSchema,
});
export type CostEstimate = z.infer<typeof costEstimateSchema>;

/**
 * Price a set of token counts.
 *
 * Cached input falls back to the full input rate when the vendor publishes no
 * cache discount: over-charging our own ledger is safe, under-charging is how a
 * budget cap gets quietly overrun.
 */
export function priceUsage(
  pricing: ModelPricing,
  usage: TokenUsage,
  basis: CostBasis,
): CostEstimate {
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const cachedRate = pricing.cachedInputPerMTokUsd ?? pricing.inputPerMTokUsd;
  const writeRate = pricing.cacheWritePerMTokUsd ?? pricing.inputPerMTokUsd;

  const costUsd =
    (usage.inputTokens * pricing.inputPerMTokUsd +
      usage.outputTokens * pricing.outputPerMTokUsd +
      cachedInputTokens * cachedRate +
      cacheWriteTokens * writeRate) /
    TOKENS_PER_PRICING_UNIT;

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    costUsd: roundUsd(costUsd),
    basis,
  };
}

/** Price against a descriptor, refusing rather than guessing when it has no rates. */
export function priceUsageFor(
  descriptor: ModelDescriptor,
  usage: TokenUsage,
  basis: CostBasis,
): CostEstimate {
  if (!descriptor.pricing) throw new PricingUnknownError(descriptor.modelId);
  return priceUsage(descriptor.pricing, usage, basis);
}

/** Narrow a gateway cost to the `Usage` shape the event log stores. */
export function toUsage(estimate: CostEstimate): Usage {
  return {
    inputTokens: estimate.inputTokens,
    outputTokens: estimate.outputTokens,
    ...(estimate.cachedInputTokens > 0 ? { cachedInputTokens: estimate.cachedInputTokens } : {}),
    costUsd: estimate.costUsd,
  };
}

/** Running total across many calls. Two estimates only add if they agree on basis. */
export function addCosts(a: CostEstimate, b: CostEstimate): CostEstimate {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: roundUsd(a.costUsd + b.costUsd),
    basis: a.basis === 'measured' && b.basis === 'measured' ? 'measured' : 'estimated',
  };
}

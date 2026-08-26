import { usageSchema } from '@sheep/core';
import { describe, expect, it } from 'vitest';
import { addCosts, priceUsage, priceUsageFor, toUsage } from './cost';
import { FREE_PRICING, type ModelPricing } from './descriptor';
import { PricingUnknownError } from './errors';
import { mockDescriptor } from './mock';

const pricing: ModelPricing = {
  inputPerMTokUsd: 3,
  outputPerMTokUsd: 15,
  cachedInputPerMTokUsd: 0.3,
  cacheWritePerMTokUsd: 3.75,
};

describe('cost accounting', () => {
  it('prices tokens at the published per-million rates', () => {
    const cost = priceUsage(pricing, { inputTokens: 1_000_000, outputTokens: 100_000 }, 'measured');

    expect(cost).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 4.5,
      basis: 'measured',
    });
  });

  it('bills cache reads and writes on their own lines', () => {
    const cost = priceUsage(
      pricing,
      {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      },
      'measured',
    );

    expect(cost.costUsd).toBe(4.05);
  });

  it('charges cached input at the full input rate when no discount is published', () => {
    const cost = priceUsage(
      { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
      { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 },
      'measured',
    );

    expect(cost.costUsd).toBe(3);
  });

  it('rounds away floating-point noise so identical runs agree', () => {
    const cost = priceUsage(pricing, { inputTokens: 7, outputTokens: 3 }, 'estimated');
    expect(cost.costUsd).toBe(0.000066);
  });

  it('charges nothing for a free model, and refuses to guess an unpriced one', () => {
    const local = mockDescriptor({ pricing: FREE_PRICING, local: true });
    expect(
      priceUsageFor(local, { inputTokens: 9_000, outputTokens: 4_000 }, 'measured').costUsd,
    ).toBe(0);

    const unpriced = mockDescriptor({ modelId: 'mystery-1', pricing: null });
    expect(() => priceUsageFor(unpriced, { inputTokens: 1, outputTokens: 1 }, 'measured')).toThrow(
      PricingUnknownError,
    );
  });

  it('narrows to the Usage the event log stores', () => {
    const cost = priceUsage(
      pricing,
      { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20 },
      'measured',
    );

    const usage = toUsage(cost);
    expect(usageSchema.parse(usage)).toEqual(usage);
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
      costUsd: cost.costUsd,
    });
    // No cached tokens means no key at all, not a zero.
    expect(
      toUsage(priceUsage(pricing, { inputTokens: 1, outputTokens: 1 }, 'measured')),
    ).not.toHaveProperty('cachedInputTokens');
  });

  it('adds costs, and demotes the total to an estimate if either side was one', () => {
    const measured = priceUsage(pricing, { inputTokens: 100, outputTokens: 100 }, 'measured');
    const estimated = priceUsage(pricing, { inputTokens: 100, outputTokens: 100 }, 'estimated');

    expect(addCosts(measured, measured).basis).toBe('measured');
    expect(addCosts(measured, estimated).basis).toBe('estimated');
    expect(addCosts(measured, measured)).toMatchObject({
      inputTokens: 200,
      outputTokens: 200,
      costUsd: measured.costUsd * 2,
    });
  });
});

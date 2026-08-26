import { describe, expect, it } from 'vitest';
import { collectDeltas } from '../delta';
import { FREE_PRICING } from '../descriptor';
import { BudgetExceededError, PricingUnknownError } from '../errors';
import { MockAdapter, mockDescriptor } from '../mock';
import { AdapterRegistry } from '../registry';
import type { NormalizedRequest } from '../request';
import { withResilience } from '../resilience/resilient-adapter';
import { withBudget } from './budgeted-adapter';
import { BudgetGovernor, type BudgetEvent } from './governor';
import { estimateInputTokens, PricingTable } from './pricing';

/** $1 in, $5 out per million: one dollar of output is 200k tokens. */
const PRICED = mockDescriptor({ pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 5 } });

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    modelId: 'mock-1',
    system: null,
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'x'.repeat(400) }] }],
    maxOutputTokens: 20_000,
    ...overrides,
  };
}

describe('PricingTable', () => {
  it('lets the user’s own rate beat the shipped one', () => {
    const table = new PricingTable();
    expect(table.priceFor(PRICED)).toEqual({ inputPerMTokUsd: 1, outputPerMTokUsd: 5 });

    table.set('mock', 'mock-1', { inputPerMTokUsd: 0.5, outputPerMTokUsd: 2 });
    expect(table.priceFor(PRICED)).toEqual({ inputPerMTokUsd: 0.5, outputPerMTokUsd: 2 });
    expect(table.resolve(PRICED).pricing).toEqual({ inputPerMTokUsd: 0.5, outputPerMTokUsd: 2 });
  });

  it('supplies a price where the provider publishes none', () => {
    const unpriced = mockDescriptor({ vendorId: 'openai', modelId: 'gpt-5', pricing: null });
    const table = new PricingTable({
      'openai:gpt-5': { inputPerMTokUsd: 1.25, outputPerMTokUsd: 10 },
    });

    expect(table.priceFor(unpriced)).toEqual({ inputPerMTokUsd: 1.25, outputPerMTokUsd: 10 });
  });

  it('counts a request roughly, including its tools', () => {
    const bare = estimateInputTokens(
      request({ messages: [{ role: 'user', content: [{ kind: 'text', text: 'x'.repeat(400) }] }] }),
    );
    expect(bare).toBe(100);

    const withTools = estimateInputTokens(
      request({ tools: [{ name: 'search', description: 'd'.repeat(96), parameters: {} }] }),
    );
    expect(withTools).toBeGreaterThan(bare);
  });
});

describe('BudgetGovernor', () => {
  it('estimates the worst case, not the likely one', () => {
    const governor = new BudgetGovernor();
    const estimate = governor.estimate(PRICED, request());

    // 100 input tokens at $1/M, plus the full 20k output allowance at $5/M.
    expect(estimate).toMatchObject({ inputTokens: 100, outputTokens: 20_000, basis: 'estimated' });
    expect(estimate.costUsd).toBe(0.1001);
  });

  it('uses a real token count when the provider offers one', () => {
    const governor = new BudgetGovernor();
    expect(governor.estimate(PRICED, request(), 40_000).inputTokens).toBe(40_000);
  });

  it('refuses to guess for a model with no price on file', () => {
    const governor = new BudgetGovernor();
    const unpriced = mockDescriptor({ pricing: null });

    expect(() => governor.estimate(unpriced, request())).toThrow(PricingUnknownError);
    // Opt in, and it runs as free — a decision the user made, not a default.
    expect(new BudgetGovernor({ allowUnpriced: true }).estimate(unpriced, request()).costUsd).toBe(
      0,
    );
  });

  it('charges a local model nothing and lets it run under a cap', () => {
    const governor = new BudgetGovernor().defineScope('session', { capUsd: 0.01 });
    const local = mockDescriptor({ pricing: FREE_PRICING, local: true });

    const estimate = governor.estimate(local, request());
    expect(estimate.costUsd).toBe(0);
    expect(() => {
      governor.authorize('session', estimate);
    }).not.toThrow();
  });

  it('enforces a model’s own cap inside the session’s', () => {
    const governor = new BudgetGovernor()
      .defineScope('session', { capUsd: 10 })
      .defineScope('participant-1', { capUsd: 0.15, parentId: 'session' });

    const estimate = governor.estimate(PRICED, request());
    governor.authorize('participant-1', estimate);
    governor.record('participant-1', estimate);

    // Well inside the session cap, past the participant's own.
    expect(governor.spentUsd('session')).toBe(0.1001);
    expect(() => {
      governor.authorize('participant-1', estimate);
    }).toThrow(BudgetExceededError);
    expect(governor.haltedScopeId).toBe('participant-1');
  });
});

describe('a session at its cap', () => {
  it('stops cleanly, says what it would cost, and resumes on confirmation', async () => {
    const events: BudgetEvent[] = [];
    const governor = new BudgetGovernor({ onEvent: (event) => events.push(event) });
    // Two calls fit; the third does not.
    governor.defineScope('session', { capUsd: 0.25 });

    const spent: number[] = [];
    const adapter = withBudget(
      new MockAdapter({
        models: [PRICED],
        // Reports the usage the estimate assumed, so each call really costs
        // $0.1001 and the third one is the one that will not fit.
        respond: { text: 'ok', usage: { inputTokens: 100, outputTokens: 20_000 } },
      }),
      { governor, scope: 'session', onSpend: (cost) => spent.push(cost.costUsd) },
    );

    await collectDeltas(adapter.stream(request()));
    await collectDeltas(adapter.stream(request()));

    // Billed on what came back, measured, not on the estimate.
    expect(spent).toEqual([0.1001, 0.1001]);
    expect(governor.status).toBe('running');

    // A third would take $0.3003 out of a $0.25 cap: refused before it starts.
    await expect(collectDeltas(adapter.stream(request()))).rejects.toThrow(BudgetExceededError);

    expect(governor.status).toBe('halted');
    expect(governor.haltedScopeId).toBe('session');

    const halt = events.find((event) => event.kind === 'halted');
    expect(halt).toMatchObject({
      scopeId: 'session',
      capUsd: 0.25,
      spentUsd: 0.2002,
      wouldCostUsd: 0.1001,
    });
    // It stopped between calls, so nothing was truncated and nothing overspent.
    expect(governor.spentUsd('session')).toBe(0.2002);
    expect(spent).toHaveLength(2);

    // While halted, everything is refused — not just the call that crossed.
    await expect(collectDeltas(adapter.stream(request()))).rejects.toThrow(BudgetExceededError);

    // The human says continue, with a bigger cap.
    governor.resume({ raiseCapUsd: 5 });
    expect(governor.status).toBe('running');
    expect(events.at(-1)).toMatchObject({ kind: 'resumed', scopeId: 'session', capUsd: 5 });

    const after = await collectDeltas(adapter.stream(request()));
    expect(after.text).toBe('ok');
    expect(governor.state('session').calls).toBe(3);
    expect(governor.spentUsd('session')).toBe(0.3003);
  });

  it('resumes without raising the cap, and halts again on the next call', async () => {
    const governor = new BudgetGovernor().defineScope('session', { capUsd: 0.05 });
    const adapter = withBudget(new MockAdapter({ models: [PRICED] }), {
      governor,
      scope: 'session',
    });

    await expect(collectDeltas(adapter.stream(request()))).rejects.toThrow(BudgetExceededError);
    governor.resume();
    expect(governor.status).toBe('running');

    await expect(collectDeltas(adapter.stream(request()))).rejects.toThrow(BudgetExceededError);
    expect(governor.status).toBe('halted');
  });

  it('halts by hand when a user presses stop', () => {
    const governor = new BudgetGovernor().defineScope('session', { capUsd: 10 });
    governor.halt('session', 'the user pressed stop');

    expect(governor.status).toBe('halted');
    expect(governor.haltReason).toBe('the user pressed stop');
    governor.resume();
    expect(governor.status).toBe('running');
  });

  it('stacks with resilience and the registry without knowing about either', async () => {
    const governor = new BudgetGovernor().defineScope('session', { capUsd: 1 });
    const registry = new AdapterRegistry().register(
      withBudget(
        withResilience(new MockAdapter({ models: [PRICED], respond: { text: 'layered' } })),
        { governor, scope: 'session' },
      ),
    );

    const response = await collectDeltas(registry.stream('mock', request()));

    expect(response.text).toBe('layered');
    expect(governor.spentUsd('session')).toBeGreaterThan(0);
    expect(governor.state('session').remainingUsd).toBeLessThan(1);
  });

  it('reports a run’s total as one measured cost', () => {
    const governor = new BudgetGovernor();
    const total = BudgetGovernor.total([
      governor.estimate(PRICED, request()),
      governor.estimate(PRICED, request()),
    ]);

    expect(total.outputTokens).toBe(40_000);
    // Two estimates make an estimate, never a bill.
    expect(total.basis).toBe('estimated');
  });
});

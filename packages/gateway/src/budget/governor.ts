import { addCosts, priceUsage, roundUsd, type CostEstimate } from '../cost';
import type { ModelDescriptor } from '../descriptor';
import { BudgetExceededError, PricingUnknownError } from '../errors';
import type { NormalizedRequest } from '../request';
import { estimateInputTokens, PricingTable } from './pricing';

/**
 * What a session is allowed to spend, and what it has spent.
 *
 * Two decisions define this thing. First, a cap is enforced *between* calls,
 * never inside one: killing a stream halfway wastes the tokens already paid for
 * and leaves a truncated answer in the ledger, so a call that would cross the
 * line is refused before it starts and the session halts cleanly. Second, a
 * halt is not a failure — it is a question. The run stops, says what it would
 * cost to continue, and waits for a human to say yes; `resume()` is that yes.
 */

export interface BudgetScopeOptions {
  /** Undefined means no ceiling of its own; a parent's still applies. */
  readonly capUsd?: number;
  /** Usually the session; a model's own cap nests inside it. */
  readonly parentId?: string;
}

export interface BudgetScopeState {
  readonly id: string;
  readonly capUsd: number | null;
  readonly spentUsd: number;
  readonly remainingUsd: number | null;
  readonly parentId: string | null;
  readonly calls: number;
}

export type BudgetEvent =
  | { readonly kind: 'spend'; readonly scopeId: string; readonly cost: CostEstimate }
  | {
      readonly kind: 'halted';
      readonly scopeId: string;
      readonly reason: string;
      readonly spentUsd: number;
      readonly capUsd: number;
      readonly wouldCostUsd: number;
    }
  | { readonly kind: 'resumed'; readonly scopeId: string | null; readonly capUsd: number | null };

export interface BudgetGovernorOptions {
  readonly pricing?: PricingTable;
  readonly onEvent?: (event: BudgetEvent) => void;
  /**
   * Whether a model with no price on file may run.
   *
   * Off by default under a cap: a call whose cost cannot be predicted cannot be
   * kept inside a budget, and quietly counting it as zero is how a cap gets
   * passed without anyone noticing.
   */
  readonly allowUnpriced?: boolean;
}

export type BudgetStatus = 'running' | 'halted';

export class BudgetGovernor {
  readonly pricing: PricingTable;
  readonly #options: BudgetGovernorOptions;
  readonly #scopes = new Map<
    string,
    { options: BudgetScopeOptions; spentUsd: number; calls: number }
  >();
  #status: BudgetStatus = 'running';
  #haltedScopeId: string | null = null;
  #haltReason: string | null = null;

  constructor(options: BudgetGovernorOptions = {}) {
    this.#options = options;
    this.pricing = options.pricing ?? new PricingTable();
  }

  get status(): BudgetStatus {
    return this.#status;
  }

  get haltReason(): string | null {
    return this.#haltReason;
  }

  get haltedScopeId(): string | null {
    return this.#haltedScopeId;
  }

  /** Declares a scope. Calling it again updates the cap, keeping the spend. */
  defineScope(id: string, options: BudgetScopeOptions = {}): this {
    const existing = this.#scopes.get(id);
    this.#scopes.set(id, {
      options,
      spentUsd: existing?.spentUsd ?? 0,
      calls: existing?.calls ?? 0,
    });
    return this;
  }

  has(id: string): boolean {
    return this.#scopes.has(id);
  }

  state(id: string): BudgetScopeState {
    const scope = this.#scopes.get(id);
    if (!scope) throw new Error(`Unknown budget scope: ${id}`);
    const capUsd = scope.options.capUsd ?? null;
    return {
      id,
      capUsd,
      spentUsd: scope.spentUsd,
      remainingUsd: capUsd === null ? null : roundUsd(Math.max(0, capUsd - scope.spentUsd)),
      parentId: scope.options.parentId ?? null,
      calls: scope.calls,
    };
  }

  snapshot(): BudgetScopeState[] {
    return [...this.#scopes.keys()].map((id) => this.state(id));
  }

  /**
   * What a call is expected to cost, before it is made.
   *
   * The output side is priced at `maxOutputTokens` — the worst case, not a
   * guess at the likely one. A budget that assumed the average would be right
   * about the average and wrong exactly when it mattered.
   */
  estimate(
    descriptor: ModelDescriptor,
    request: NormalizedRequest,
    knownInputTokens?: number,
  ): CostEstimate {
    const pricing = this.pricing.priceFor(descriptor);
    const inputTokens = knownInputTokens ?? estimateInputTokens(request);
    const tokens = { inputTokens, outputTokens: request.maxOutputTokens };

    if (!pricing) {
      if (!this.#options.allowUnpriced) throw new PricingUnknownError(descriptor.modelId);
      return {
        ...tokens,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        basis: 'estimated',
      };
    }
    return priceUsage(pricing, tokens, 'estimated');
  }

  /**
   * May this call happen?
   *
   * Throws `BudgetExceededError` and halts if it would take any scope in the
   * chain past its cap — so the caller gets one clear reason rather than a
   * partial run and a surprise.
   */
  authorize(scopeId: string, estimate: CostEstimate): void {
    if (this.#status === 'halted') {
      const halted = this.#haltedScopeId ?? scopeId;
      const state = this.has(halted) ? this.state(halted) : undefined;
      throw new BudgetExceededError(
        halted,
        state?.spentUsd ?? 0,
        state?.capUsd ?? 0,
        estimate.costUsd,
      );
    }

    for (const id of this.#chain(scopeId)) {
      const scope = this.#scopes.get(id);
      const capUsd = scope?.options.capUsd;
      if (scope === undefined || capUsd === undefined) continue;

      if (roundUsd(scope.spentUsd + estimate.costUsd) > capUsd) {
        this.#halt(
          id,
          'the next call would exceed the cap',
          scope.spentUsd,
          capUsd,
          estimate.costUsd,
        );
        throw new BudgetExceededError(id, scope.spentUsd, capUsd, estimate.costUsd);
      }
    }
  }

  /** Books what a call actually cost, up the whole chain. */
  record(scopeId: string, cost: CostEstimate): void {
    for (const id of this.#chain(scopeId)) {
      const scope = this.#scopes.get(id);
      if (!scope) continue;
      scope.spentUsd = roundUsd(scope.spentUsd + cost.costUsd);
      scope.calls += 1;
    }
    this.#options.onEvent?.({ kind: 'spend', scopeId, cost });
  }

  /** Total measured spend for a scope and everything charged through it. */
  spentUsd(scopeId: string): number {
    return this.state(scopeId).spentUsd;
  }

  /** Halts by hand — a user pressing stop, or a phase deciding it has enough. */
  halt(scopeId: string, reason: string): void {
    const state = this.has(scopeId) ? this.state(scopeId) : undefined;
    this.#halt(scopeId, reason, state?.spentUsd ?? 0, state?.capUsd ?? 0, 0);
  }

  /**
   * The human said continue.
   *
   * Resuming without raising the cap is legitimate — a user may have deleted
   * some roster entries, or simply want the next call to be refused again on
   * its own merits — so the cap is only changed when one is given.
   */
  resume(options: { readonly raiseCapUsd?: number; readonly scopeId?: string } = {}): void {
    const scopeId = options.scopeId ?? this.#haltedScopeId;
    if (scopeId && options.raiseCapUsd !== undefined) {
      const scope = this.#scopes.get(scopeId);
      if (scope) {
        this.#scopes.set(scopeId, {
          ...scope,
          options: { ...scope.options, capUsd: options.raiseCapUsd },
        });
      }
    }

    this.#status = 'running';
    this.#haltReason = null;
    this.#haltedScopeId = null;
    this.#options.onEvent?.({
      kind: 'resumed',
      scopeId: scopeId ?? null,
      capUsd: scopeId && this.has(scopeId) ? this.state(scopeId).capUsd : null,
    });
  }

  /** Total across every root scope — what the whole app has spent. */
  totalUsd(): number {
    const roots = [...this.#scopes.entries()].filter(([, scope]) => !scope.options.parentId);
    return roots.reduce((total, [, scope]) => roundUsd(total + scope.spentUsd), 0);
  }

  /** Sums a run's measured costs, for a report. */
  static total(costs: readonly CostEstimate[]): CostEstimate {
    return costs.reduce((running, cost) => addCosts(running, cost), {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      basis: 'measured' as const,
    });
  }

  #halt(
    scopeId: string,
    reason: string,
    spentUsd: number,
    capUsd: number,
    wouldCostUsd: number,
  ): void {
    this.#status = 'halted';
    this.#haltedScopeId = scopeId;
    this.#haltReason = reason;
    this.#options.onEvent?.({ kind: 'halted', scopeId, reason, spentUsd, capUsd, wouldCostUsd });
  }

  /** A scope and its ancestors, nearest first. Cycles are ignored, not fatal. */
  #chain(scopeId: string): string[] {
    const chain: string[] = [];
    let current: string | undefined = scopeId;
    while (current && !chain.includes(current)) {
      chain.push(current);
      current = this.#scopes.get(current)?.options.parentId;
    }
    return chain;
  }
}

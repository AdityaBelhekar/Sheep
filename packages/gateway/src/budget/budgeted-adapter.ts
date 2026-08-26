import type { AdapterId, ListModelsOptions, ModelAdapter, StreamOptions } from '../adapter';
import { priceUsage, type CostEstimate } from '../cost';
import type { Delta } from '../delta';
import type { ModelDescriptor } from '../descriptor';
import { UnknownModelError } from '../errors';
import type { NormalizedRequest } from '../request';
import type { BudgetGovernor } from './governor';

/**
 * An adapter that will not spend more than it is allowed to.
 *
 * Same wrapper shape as the resilience layer, and for the same reason: the cost
 * rules are written once and every provider gets them, including ones added
 * later. Stack it outside resilience — retries are attempts at one authorised
 * call, and paying twice for one authorisation is exactly what the retry logic
 * is careful not to do.
 */

export interface BudgetedAdapterOptions {
  readonly governor: BudgetGovernor;
  /**
   * Which budget this adapter's calls are charged to. A function so one
   * adapter can serve many sessions, reading the scope off the request.
   */
  readonly scope: string | ((request: NormalizedRequest) => string);
  /** Called with the pre-run estimate, for a "this will cost about" line. */
  readonly onEstimate?: (estimate: CostEstimate, request: NormalizedRequest) => void;
  /** Called with what it actually cost, once the stream ends. */
  readonly onSpend?: (cost: CostEstimate, request: NormalizedRequest) => void;
}

export function withBudget(
  adapter: ModelAdapter,
  options: BudgetedAdapterOptions,
): BudgetedAdapter {
  return new BudgetedAdapter(adapter, options);
}

export class BudgetedAdapter implements ModelAdapter {
  readonly adapterId: AdapterId;
  readonly vendorId: string;
  readonly #inner: ModelAdapter;
  readonly #options: BudgetedAdapterOptions;

  constructor(inner: ModelAdapter, options: BudgetedAdapterOptions) {
    this.#inner = inner;
    this.#options = options;
    this.adapterId = inner.adapterId;
    this.vendorId = inner.vendorId;
  }

  listModels(options?: ListModelsOptions): Promise<ModelDescriptor[]> {
    return this.#inner.listModels(options);
  }

  describeModel(modelId: string, options?: ListModelsOptions): Promise<ModelDescriptor | null> {
    return this.#inner.describeModel(modelId, options);
  }

  countInputTokens(request: NormalizedRequest, options?: StreamOptions): Promise<number> {
    return this.#inner.countInputTokens?.(request, options) ?? Promise.resolve(0);
  }

  close(): Promise<void> {
    return this.#inner.close?.() ?? Promise.resolve();
  }

  /** What this call is expected to cost, without making it. */
  async estimate(request: NormalizedRequest, options: StreamOptions = {}): Promise<CostEstimate> {
    const descriptor = await this.#describe(request.modelId, options);
    // A provider that counts tokens for us is worth the extra round trip: it
    // turns the input half of the estimate from arithmetic into a fact.
    const counted = await this.#inner.countInputTokens?.(request, options).catch(() => undefined);
    return this.#options.governor.estimate(descriptor, request, counted);
  }

  async *stream(
    request: NormalizedRequest,
    options: StreamOptions = {},
  ): AsyncGenerator<Delta, void, undefined> {
    const governor = this.#options.governor;
    const scope =
      typeof this.#options.scope === 'function'
        ? this.#options.scope(request)
        : this.#options.scope;

    const descriptor = await this.#describe(request.modelId, options);
    const estimate = await this.estimate(request, options);
    this.#options.onEstimate?.(estimate, request);

    // Refused before the call, so nothing is spent and no stream is truncated.
    governor.authorize(scope, estimate);

    for await (const delta of this.#inner.stream(request, options)) {
      yield delta;

      if (delta.kind === 'end') {
        const pricing = governor.pricing.priceFor(descriptor);
        // Billed on what the provider reported, never on the estimate — the
        // estimate was the worst case, and charging it would be wrong twice.
        const cost = pricing
          ? priceUsage(pricing, delta.usage, 'measured')
          : { ...zeroTokens(delta), costUsd: 0, basis: 'measured' as const };

        governor.record(scope, cost);
        this.#options.onSpend?.(cost, request);
      }
    }
  }

  async #describe(modelId: string, options: StreamOptions): Promise<ModelDescriptor> {
    const descriptor = await this.#inner.describeModel(modelId, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!descriptor) throw new UnknownModelError(this.adapterId, modelId);
    return this.#options.governor.pricing.resolve(descriptor);
  }
}

function zeroTokens(
  delta: Extract<Delta, { kind: 'end' }>,
): Omit<CostEstimate, 'costUsd' | 'basis'> {
  return {
    inputTokens: delta.usage.inputTokens,
    outputTokens: delta.usage.outputTokens,
    cachedInputTokens: delta.usage.cachedInputTokens ?? 0,
    cacheWriteTokens: delta.usage.cacheWriteTokens ?? 0,
  };
}

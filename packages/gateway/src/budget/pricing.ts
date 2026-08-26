import type { ModelDescriptor, ModelPricing } from '../descriptor';
import type { NormalizedRequest } from '../request';

/**
 * Prices, in one place, with the user's own numbers on top.
 *
 * A descriptor already carries what the adapter knows — list prices for
 * Anthropic, live prices from OpenRouter, zero for a local model, `null` where
 * nobody publishes any. This table is the layer above that: an enterprise rate,
 * a negotiated discount, or simply the price for a provider that publishes
 * none. An override wins over the descriptor, because a user who has typed in
 * their actual contract knows better than a table shipped months ago.
 */

/** `vendor:model` — a model id alone is ambiguous across proxies. */
export function pricingKey(vendorId: string, modelId: string): string {
  return `${vendorId}:${modelId}`;
}

export class PricingTable {
  readonly #overrides = new Map<string, ModelPricing>();

  constructor(entries: Readonly<Record<string, ModelPricing>> = {}) {
    for (const [key, pricing] of Object.entries(entries)) this.#overrides.set(key, pricing);
  }

  set(vendorId: string, modelId: string, pricing: ModelPricing): this {
    this.#overrides.set(pricingKey(vendorId, modelId), pricing);
    return this;
  }

  delete(vendorId: string, modelId: string): boolean {
    return this.#overrides.delete(pricingKey(vendorId, modelId));
  }

  /** The price to use, or `null` when nothing anywhere knows one. */
  priceFor(descriptor: ModelDescriptor): ModelPricing | null {
    return (
      this.#overrides.get(pricingKey(descriptor.vendorId, descriptor.modelId)) ?? descriptor.pricing
    );
  }

  /** The descriptor as the budget layer sees it, with prices resolved. */
  resolve(descriptor: ModelDescriptor): ModelDescriptor {
    const pricing = this.priceFor(descriptor);
    return pricing === descriptor.pricing ? descriptor : { ...descriptor, pricing };
  }

  entries(): [string, ModelPricing][] {
    return [...this.#overrides.entries()];
  }
}

/**
 * A token count for a request nobody has sent yet.
 *
 * Four characters to a token is wrong for every tokenizer and close enough to
 * decide whether a call fits in a budget — and it is only ever used when the
 * provider offers no `countTokens` endpoint. What matters is that the result is
 * marked `estimated`, so nothing downstream mistakes it for a bill.
 */
export function estimateInputTokens(request: NormalizedRequest): number {
  let characters = request.system?.length ?? 0;

  for (const message of request.messages) {
    for (const part of message.content) {
      switch (part.kind) {
        case 'text':
          characters += part.text.length;
          break;
        case 'tool_use':
          characters += part.name.length + part.argumentsJson.length;
          break;
        case 'tool_result':
          characters += part.content.length;
          break;
        case 'image':
          // Base64 is roughly 4/3 of the bytes, and an image costs far less
          // than its encoding suggests; a flat allowance beats a wrong formula.
          characters += 1_000;
          break;
      }
    }
  }

  for (const tool of request.tools ?? []) {
    characters +=
      tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length;
  }

  return Math.ceil(characters / 4);
}

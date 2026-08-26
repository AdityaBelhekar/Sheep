import {
  modelIdSchema,
  slugSchema,
  titleSchema,
  tokenCountSchema,
  usdSchema,
  vendorIdSchema,
} from '@sheep/core';
import { z } from 'zod';

/**
 * What a model can be asked to do.
 *
 * Two kinds of flag live in one list on purpose. Most are *derivable* — the
 * registry reads a `NormalizedRequest`, works out which flags it needs, and
 * refuses the call if the model lacks one (see `requiredCapabilities`). The
 * rest (`promptCaching`, `parallelToolCalls`) are advisory: nothing in the
 * request implies them, but the roster UI and later cost work need to know.
 *
 * `streaming` is listed even though every adapter must stream, because a
 * provider that only returns whole responses is still reachable behind an
 * adapter that fakes a single text delta — and the descriptor should say so.
 */
export const MODEL_CAPABILITIES = [
  'streaming',
  'systemPrompt',
  'tools',
  'parallelToolCalls',
  'vision',
  'reasoning',
  'jsonSchemaOutput',
  'promptCaching',
  'stopSequences',
  'temperature',
  'topP',
  'seed',
] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export const modelCapabilitySchema = z.enum(MODEL_CAPABILITIES);

/**
 * Every flag stated, none inferred.
 *
 * A missing flag would read as "unknown" and get treated as "no" somewhere and
 * "yes" somewhere else; requiring all twelve makes an adapter author decide.
 * Use `capabilities()` to write one without listing the falses.
 */
export const capabilityFlagsSchema = z.strictObject(
  Object.fromEntries(MODEL_CAPABILITIES.map((name) => [name, z.boolean()])) as {
    [K in ModelCapability]: z.ZodBoolean;
  },
);
export type CapabilityFlags = z.infer<typeof capabilityFlagsSchema>;

/** Every capability off, then whatever the caller turns on. */
export function capabilities(enabled: Partial<CapabilityFlags> = {}): CapabilityFlags {
  const flags = Object.fromEntries(
    MODEL_CAPABILITIES.map((name) => [name, enabled[name] ?? false]),
  ) as CapabilityFlags;
  return flags;
}

/**
 * Price per million tokens, the unit every vendor publishes.
 *
 * Per-million rather than per-token because per-token rates are values like
 * `0.000003` that lose precision in a way nobody reviewing a pricing table can
 * spot. Cache reads and cache writes are separate line items, never derived
 * from the input rate.
 */
export const modelPricingSchema = z.strictObject({
  inputPerMTokUsd: usdSchema,
  outputPerMTokUsd: usdSchema,
  cachedInputPerMTokUsd: usdSchema.optional(),
  cacheWritePerMTokUsd: usdSchema.optional(),
});
export type ModelPricing = z.infer<typeof modelPricingSchema>;

/** A local model that costs nothing to run. Not the same as unknown pricing. */
export const FREE_PRICING: ModelPricing = {
  inputPerMTokUsd: 0,
  outputPerMTokUsd: 0,
};

/**
 * One model, as the gateway understands it.
 *
 * This is the answer to "may I send this request, and what will it cost" —
 * everything needed to decide that, and nothing that changes per call.
 *
 * `pricing: null` means *unknown*, and is deliberately distinguishable from
 * `FREE_PRICING`: a budget governor (Phase 17) must be able to refuse to run
 * a model whose cost it cannot predict, while happily running a free one.
 */
export const modelDescriptorSchema = z.strictObject({
  vendorId: vendorIdSchema,
  modelId: modelIdSchema,
  /** Human label for the roster. Safe to change; never stored in an event. */
  displayName: titleSchema,
  /** Groups aliases that share weights, e.g. `claude-opus-5`. */
  family: slugSchema.optional(),
  contextWindowTokens: tokenCountSchema,
  maxOutputTokens: tokenCountSchema,
  capabilities: capabilityFlagsSchema,
  pricing: modelPricingSchema.nullable(),
  /** ISO date of the training cutoff, when the vendor publishes one. */
  knowledgeCutoff: z.string().min(1).max(40).optional(),
  /** True for anything reached over loopback; drives the offline badge. */
  local: z.boolean(),
});
export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;

/** Capabilities the descriptor claims, in declaration order. */
export function supportedCapabilities(descriptor: ModelDescriptor): ModelCapability[] {
  return MODEL_CAPABILITIES.filter((name) => descriptor.capabilities[name]);
}

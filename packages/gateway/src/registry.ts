import type { VendorId } from '@sheep/core';
import type { z } from 'zod';
import type { AdapterId, ListModelsOptions, ModelAdapter, StreamOptions } from './adapter';
import { deltaSchema, type Delta } from './delta';
import type { ModelDescriptor } from './descriptor';
import {
  DuplicateAdapterError,
  InvalidDeltaError,
  InvalidRequestError,
  StreamCancelledError,
  StreamProtocolError,
  UnknownAdapterError,
  UnknownModelError,
  UnsupportedCapabilityError,
} from './errors';
import { missingCapabilities, normalizedRequestSchema, type NormalizedRequest } from './request';

export interface AdapterRegistryOptions {
  /**
   * Parse every delta against its schema before passing it on.
   *
   * On by default. An adapter is where third-party JSON becomes Sheep data, so
   * it gets the same treatment the IPC boundary gets: a malformed delta fails
   * loudly at the seam instead of turning into a corrupt message three layers
   * downstream. Turn it off only if profiling ever says it matters.
   */
  readonly validateDeltas?: boolean;
}

/** One model on one connection. */
export interface ModelHandle {
  readonly adapterId: AdapterId;
  readonly descriptor: ModelDescriptor;
}

/**
 * The set of adapters this app can route to, and the rules they all obey.
 *
 * Registering here rather than calling adapters directly is what makes those
 * rules unskippable: the request is validated, the model is confirmed to exist
 * and to support what is being asked of it, the delta stream is checked as it
 * flows, and cancellation is honoured — for every provider, including ones
 * written later by someone who never read this file.
 */
export class AdapterRegistry {
  readonly #adapters = new Map<AdapterId, ModelAdapter>();
  readonly #validateDeltas: boolean;

  constructor(options: AdapterRegistryOptions = {}) {
    this.#validateDeltas = options.validateDeltas ?? true;
  }

  register(adapter: ModelAdapter): this {
    if (this.#adapters.has(adapter.adapterId)) {
      throw new DuplicateAdapterError(adapter.adapterId);
    }
    this.#adapters.set(adapter.adapterId, adapter);
    return this;
  }

  /** Removes and closes an adapter. False if nothing was registered under that id. */
  async unregister(adapterId: string): Promise<boolean> {
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) return false;
    this.#adapters.delete(adapterId);
    await adapter.close?.();
    return true;
  }

  has(adapterId: string): boolean {
    return this.#adapters.has(adapterId);
  }

  get(adapterId: string): ModelAdapter {
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) throw new UnknownAdapterError(adapterId);
    return adapter;
  }

  /** Registration order, which is the order connections were added. */
  adapters(): ModelAdapter[] {
    return [...this.#adapters.values()];
  }

  /** Every adapter speaking for one vendor — several, once a vendor has two keys. */
  byVendor(vendorId: VendorId): ModelAdapter[] {
    return this.adapters().filter((adapter) => adapter.vendorId === vendorId);
  }

  /** The whole catalogue, adapter by adapter. Rejects if any adapter does. */
  async listModels(options?: ListModelsOptions): Promise<ModelHandle[]> {
    const handles: ModelHandle[] = [];
    for (const adapter of this.adapters()) {
      const descriptors = await adapter.listModels(options);
      for (const descriptor of descriptors) {
        handles.push({ adapterId: adapter.adapterId, descriptor });
      }
    }
    return handles;
  }

  async describe(
    adapterId: string,
    modelId: string,
    options?: ListModelsOptions,
  ): Promise<ModelDescriptor> {
    const adapter = this.get(adapterId);
    const descriptor = await adapter.describeModel(modelId, options);
    if (!descriptor) throw new UnknownModelError(adapterId, modelId);
    return descriptor;
  }

  /**
   * Run a request through one adapter.
   *
   * Everything that can be refused is refused before the adapter is touched, so
   * a rejected call costs nothing and a started call is one Sheep believes in.
   */
  async *stream(
    adapterId: string,
    request: NormalizedRequest,
    options: StreamOptions = {},
  ): AsyncGenerator<Delta, void, undefined> {
    const adapter = this.get(adapterId);

    const parsed = normalizedRequestSchema.safeParse(request);
    if (!parsed.success) throw new InvalidRequestError(describeIssues(parsed.error));
    const validRequest = parsed.data;

    const descriptor = await this.describe(adapterId, validRequest.modelId, {
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const missing = missingCapabilities(descriptor, validRequest);
    if (missing.length > 0) throw new UnsupportedCapabilityError(descriptor.modelId, missing);

    const guard = new StreamGuard(adapter.adapterId);

    for await (const raw of adapter.stream(validRequest, options)) {
      if (options.signal?.aborted) throw new StreamCancelledError(adapter.adapterId);
      const delta = this.#checkDelta(adapter.adapterId, raw);
      guard.accept(delta);
      yield delta;
    }

    guard.finish();
  }

  #checkDelta(adapterId: AdapterId, raw: Delta): Delta {
    if (!this.#validateDeltas) return raw;
    const parsed = deltaSchema.safeParse(raw);
    if (!parsed.success) throw new InvalidDeltaError(adapterId, describeIssues(parsed.error));
    return parsed.data;
  }
}

/**
 * The delta protocol, enforced.
 *
 * A well-formed stream is `start`, then any number of content deltas, then
 * exactly one `end`; argument fragments belong to a tool call that has started
 * and has not ended. These are cheap invariants to check and expensive ones to
 * debug from a half-written transcript, which is what a violation produces once
 * Phase 20 renders these live.
 */
class StreamGuard {
  readonly #adapterId: AdapterId;
  readonly #openCalls = new Set<string>();
  readonly #seenCalls = new Set<string>();
  #started = false;
  #ended = false;

  constructor(adapterId: AdapterId) {
    this.#adapterId = adapterId;
  }

  accept(delta: Delta): void {
    if (this.#ended) this.#fail(`emitted ${delta.kind} after end`);

    if (delta.kind === 'start') {
      if (this.#started) this.#fail('emitted a second start');
      this.#started = true;
      return;
    }
    if (!this.#started) this.#fail(`emitted ${delta.kind} before start`);

    switch (delta.kind) {
      case 'tool_call_start':
        if (this.#seenCalls.has(delta.callId)) this.#fail(`reused tool call id ${delta.callId}`);
        this.#seenCalls.add(delta.callId);
        this.#openCalls.add(delta.callId);
        break;
      case 'tool_call_delta':
        if (!this.#openCalls.has(delta.callId)) {
          this.#fail(`sent arguments for unopened tool call ${delta.callId}`);
        }
        break;
      case 'tool_call_end':
        if (!this.#openCalls.delete(delta.callId)) {
          this.#fail(`closed unopened tool call ${delta.callId}`);
        }
        break;
      case 'end':
        if (this.#openCalls.size > 0) {
          this.#fail(`ended with tool calls still open: ${[...this.#openCalls].join(', ')}`);
        }
        this.#ended = true;
        break;
      default:
        break;
    }
  }

  finish(): void {
    if (!this.#started) this.#fail('produced no deltas at all');
    if (!this.#ended) this.#fail('stopped without an end delta');
  }

  #fail(reason: string): never {
    throw new StreamProtocolError(this.#adapterId, reason);
  }
}

function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

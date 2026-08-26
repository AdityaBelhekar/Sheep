import { describe, expect, it } from 'vitest';
import { collectDeltas, type Delta } from './delta';
import { capabilities, type ModelDescriptor } from './descriptor';
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
import { MockAdapter, MOCK_MODEL_ID, mockDescriptor } from './mock';
import { AdapterRegistry } from './registry';
import type { NormalizedRequest } from './request';

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    modelId: MOCK_MODEL_ID,
    system: null,
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Why is the sky blue?' }] }],
    maxOutputTokens: 256,
    ...overrides,
  };
}

async function drain(stream: AsyncIterable<Delta>): Promise<Delta[]> {
  const deltas: Delta[] = [];
  for await (const delta of stream) deltas.push(delta);
  return deltas;
}

describe('AdapterRegistry', () => {
  it('streams a mock adapter through the registry', async () => {
    const adapter = new MockAdapter({ respond: { text: 'Rayleigh scattering.', chunkSize: 4 } });
    const registry = new AdapterRegistry().register(adapter);

    const deltas = await drain(registry.stream(adapter.adapterId, request()));

    expect(deltas[0]?.kind).toBe('start');
    expect(deltas.at(-1)?.kind).toBe('end');
    // Chunked, not delivered whole: this is a stream, not a response.
    expect(deltas.filter((delta) => delta.kind === 'text')).toHaveLength(5);

    const response = await collectDeltas(toStream(deltas));
    expect(response.text).toBe('Rayleigh scattering.');
    expect(response.stopReason).toBe('stop');
    expect(response.model.vendorId).toBe('mock');
    expect(response.usage.outputTokens).toBeGreaterThan(0);

    // The adapter saw the parsed request, not the caller's object.
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]?.messages[0]?.content[0]).toEqual({
      kind: 'text',
      text: 'Why is the sky blue?',
    });
  });

  it('reassembles fragmented tool calls', async () => {
    const adapter = new MockAdapter({
      respond: {
        text: '',
        toolCalls: [
          { callId: 'call_1', name: 'search', argumentsJson: '{"q":"sky"}', chunkSize: 3 },
        ],
      },
    });
    const registry = new AdapterRegistry().register(adapter);

    const deltas = await drain(registry.stream('mock', request()));
    expect(deltas.filter((delta) => delta.kind === 'tool_call_delta').length).toBeGreaterThan(1);

    const response = await collectDeltas(toStream(deltas));
    expect(response.stopReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([
      { callId: 'call_1', name: 'search', argumentsJson: '{"q":"sky"}' },
    ]);
  });

  it('routes by adapter id and vendor, and closes on unregister', async () => {
    const anthropic = new MockAdapter({ adapterId: 'anthropic-work', vendorId: 'anthropic' });
    const personal = new MockAdapter({ adapterId: 'anthropic-personal', vendorId: 'anthropic' });
    const registry = new AdapterRegistry().register(anthropic).register(personal);

    expect(registry.byVendor('anthropic').map((a) => a.adapterId)).toEqual([
      'anthropic-work',
      'anthropic-personal',
    ]);
    expect(await registry.listModels()).toHaveLength(2);

    expect(await registry.unregister('anthropic-work')).toBe(true);
    expect(anthropic.closed).toBe(true);
    expect(registry.has('anthropic-work')).toBe(false);
    expect(await registry.unregister('anthropic-work')).toBe(false);
  });

  it('refuses a duplicate adapter id', () => {
    const registry = new AdapterRegistry().register(new MockAdapter());
    expect(() => registry.register(new MockAdapter())).toThrow(DuplicateAdapterError);
  });

  it('rejects an unknown adapter and an unknown model', async () => {
    const registry = new AdapterRegistry().register(new MockAdapter());

    await expect(drain(registry.stream('nope', request()))).rejects.toThrow(UnknownAdapterError);
    await expect(drain(registry.stream('mock', request({ modelId: 'gpt-9' })))).rejects.toThrow(
      UnknownModelError,
    );
  });

  it('rejects a request that fails its schema before touching the adapter', async () => {
    const adapter = new MockAdapter();
    const registry = new AdapterRegistry().register(adapter);

    await expect(drain(registry.stream('mock', request({ maxOutputTokens: 0 })))).rejects.toThrow(
      InvalidRequestError,
    );
    expect(adapter.requests).toHaveLength(0);
  });

  it('refuses a capability the model does not have, rather than silently dropping it', async () => {
    const textOnly: ModelDescriptor = mockDescriptor({
      capabilities: capabilities({ streaming: true, systemPrompt: true }),
    });
    const adapter = new MockAdapter({ models: [textOnly] });
    const registry = new AdapterRegistry().register(adapter);

    const withTools = request({
      tools: [{ name: 'search', description: 'Search the web', parameters: { type: 'object' } }],
      temperature: 0.2,
    });

    await expect(drain(registry.stream('mock', withTools))).rejects.toMatchObject({
      name: 'UnsupportedCapabilityError',
      capabilities: ['tools', 'temperature'],
    });
    await expect(drain(registry.stream('mock', withTools))).rejects.toThrow(
      UnsupportedCapabilityError,
    );
    expect(adapter.requests).toHaveLength(0);
  });

  it('rejects a delta that is not a delta', async () => {
    const adapter = new MockAdapter({
      respond: {
        deltas: [
          { kind: 'start', model: { vendorId: 'mock', modelId: MOCK_MODEL_ID } },
          { kind: 'text', text: 42 } as unknown as Delta,
        ],
      },
    });
    const registry = new AdapterRegistry().register(adapter);

    await expect(drain(registry.stream('mock', request()))).rejects.toThrow(InvalidDeltaError);
  });

  it.each([
    {
      name: 'no end delta',
      deltas: [
        { kind: 'start', model: { vendorId: 'mock', modelId: MOCK_MODEL_ID } },
        { kind: 'text', text: 'half an answer' },
      ] as Delta[],
      reason: /without an end delta/,
    },
    {
      name: 'content before start',
      deltas: [{ kind: 'text', text: 'surprise' }] as Delta[],
      reason: /before start/,
    },
    {
      name: 'arguments for an unopened tool call',
      deltas: [
        { kind: 'start', model: { vendorId: 'mock', modelId: MOCK_MODEL_ID } },
        { kind: 'tool_call_delta', callId: 'ghost', argumentsJson: '{}' },
      ] as Delta[],
      reason: /unopened tool call/,
    },
    {
      name: 'ends with a tool call still open',
      deltas: [
        { kind: 'start', model: { vendorId: 'mock', modelId: MOCK_MODEL_ID } },
        { kind: 'tool_call_start', callId: 'call_1', name: 'search' },
        { kind: 'end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ] as Delta[],
      reason: /still open/,
    },
  ])('rejects an out-of-order stream: $name', async ({ deltas, reason }) => {
    const registry = new AdapterRegistry().register(new MockAdapter({ respond: { deltas } }));

    const failure = drain(registry.stream('mock', request()));
    await expect(failure).rejects.toThrow(StreamProtocolError);
    await expect(failure).rejects.toThrow(reason);
  });

  it('stops mid-stream when the caller aborts', async () => {
    const adapter = new MockAdapter({
      respond: { text: 'a very long answer that keeps going and going', chunkSize: 2 },
    });
    const registry = new AdapterRegistry().register(adapter);
    const controller = new AbortController();

    const received: Delta[] = [];
    const run = async (): Promise<void> => {
      for await (const delta of registry.stream('mock', request(), {
        signal: controller.signal,
      })) {
        received.push(delta);
        if (received.length === 3) controller.abort();
      }
    };

    await expect(run()).rejects.toThrow(StreamCancelledError);
    expect(received).toHaveLength(3);
  });

  it('propagates an adapter failure instead of ending the stream cleanly', async () => {
    const boom = new Error('provider exploded');
    const registry = new AdapterRegistry().register(
      new MockAdapter({
        respond: { text: 'partial answer', chunkSize: 4, throwAfter: 2, error: boom },
      }),
    );

    await expect(drain(registry.stream('mock', request()))).rejects.toThrow(boom);
  });
});

async function* toStream(deltas: readonly Delta[]): AsyncGenerator<Delta, void, undefined> {
  for (const delta of deltas) yield delta;
}

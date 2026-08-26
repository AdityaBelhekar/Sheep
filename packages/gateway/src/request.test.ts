import { describe, expect, it } from 'vitest';
import { capabilities, MODEL_CAPABILITIES, supportedCapabilities } from './descriptor';
import { mockDescriptor } from './mock';
import {
  missingCapabilities,
  normalizedRequestSchema,
  requiredCapabilities,
  type NormalizedRequest,
} from './request';

const base: NormalizedRequest = {
  modelId: 'mock-1',
  system: null,
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'hello' }] }],
  maxOutputTokens: 128,
};

describe('NormalizedRequest', () => {
  it('accepts the minimum a call needs and nothing more', () => {
    expect(normalizedRequestSchema.parse(base)).toEqual(base);
    expect(
      normalizedRequestSchema.safeParse({ ...base, stream: true }).success,
      'unknown keys must not pass silently',
    ).toBe(false);
  });

  it('requires an explicit output cap', () => {
    const { maxOutputTokens: _omitted, ...uncapped } = base;
    expect(normalizedRequestSchema.safeParse(uncapped).success).toBe(false);
    expect(normalizedRequestSchema.safeParse({ ...base, maxOutputTokens: 0 }).success).toBe(false);
  });

  it('derives the capabilities a request exercises', () => {
    expect(requiredCapabilities(base)).toEqual(['streaming']);

    const loaded: NormalizedRequest = {
      ...base,
      system: 'You are a critic.',
      messages: [
        {
          role: 'user',
          content: [
            { kind: 'text', text: 'what is this' },
            { kind: 'image', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' },
          ],
        },
        {
          role: 'assistant',
          content: [{ kind: 'tool_use', callId: 'c1', name: 'search', argumentsJson: '{}' }],
        },
      ],
      responseFormat: { kind: 'json_schema', name: 'verdict', schema: { type: 'object' } },
      stopSequences: ['\n\n'],
      temperature: 0.7,
      topP: 0.9,
      seed: 42,
    };

    expect(new Set(requiredCapabilities(loaded))).toEqual(
      new Set([
        'streaming',
        'systemPrompt',
        'jsonSchemaOutput',
        'stopSequences',
        'temperature',
        'topP',
        'seed',
        'vision',
        'tools',
      ]),
    );
  });

  it('reports exactly what a model is missing', () => {
    const plain = mockDescriptor({ capabilities: capabilities({ streaming: true }) });
    expect(missingCapabilities(plain, base)).toEqual([]);
    expect(missingCapabilities(plain, { ...base, system: 'be brief', seed: 1 })).toEqual([
      'systemPrompt',
      'seed',
    ]);

    const everything = mockDescriptor();
    expect(supportedCapabilities(everything)).toEqual([...MODEL_CAPABILITIES]);
    expect(missingCapabilities(everything, { ...base, system: 'be brief', seed: 1 })).toEqual([]);
  });
});

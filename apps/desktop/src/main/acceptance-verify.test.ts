import { describe, expect, it } from 'vitest';
import { chooseRoster, type OfferedModel } from './acceptance-verify';

const model = (vendorId: string, modelId: string, local = false): OfferedModel => ({
  connectionId: '99999999-9999-4999-8999-999999999999',
  connectionLabel: `My ${vendorId}`,
  adapterId: `${vendorId}-1`,
  vendorId,
  modelId,
  displayName: modelId,
  contextWindowTokens: 8_192,
  maxOutputTokens: 4_096,
  local,
  inputPerMTokUsd: local ? 0 : 1,
  outputPerMTokUsd: local ? 0 : 2,
});

const OFFERED = [
  model('anthropic', 'claude-a'),
  model('anthropic', 'claude-b'),
  model('ollama', 'qwen', true),
  model('openai', 'gpt-a'),
];

describe('choosing an acceptance roster', () => {
  it('takes one model from each of two cloud vendors, and one local model', () => {
    expect(chooseRoster(OFFERED, []).map((entry) => entry.modelId)).toEqual([
      'claude-a',
      'gpt-a',
      'qwen',
    ]);
  });

  it('says what is missing rather than running with less', () => {
    expect(() => chooseRoster([], [])).toThrow(/0 cloud vendor\(s\) and no local model/);
    expect(() => chooseRoster(OFFERED.slice(0, 3), [])).toThrow(
      /1 cloud vendor\(s\) and a local model/,
    );
    expect(() => chooseRoster([OFFERED[0]!, OFFERED[3]!], [])).toThrow(
      /2 cloud vendor\(s\) and no local/,
    );
  });

  it('takes the models named, by id or by connection and id, and holds them to two vendors', () => {
    expect(
      chooseRoster(OFFERED, ['claude-b', 'My openai/gpt-a', 'qwen']).map((entry) => entry.modelId),
    ).toEqual(['claude-b', 'gpt-a', 'qwen']);
    expect(() => chooseRoster(OFFERED, ['gpt-5'])).toThrow(
      /no saved connection offers a model called "gpt-5"/,
    );
    expect(() => chooseRoster(OFFERED, ['claude-a', 'claude-b'])).toThrow(/all from one vendor/);
  });
});

import { describe, expect, it } from 'vitest';
import { priceUsageFor } from '../cost';
import { collectDeltas } from '../delta';
import { AdapterRegistry } from '../registry';
import { AnthropicAdapter } from './anthropic';

/**
 * The phase's "done when", against the real API.
 *
 * Skipped unless `ANTHROPIC_API_KEY` is set, so CI and a laptop with no key
 * stay green — but the check is a test rather than a script, so it runs the
 * moment a key exists instead of being a paragraph in a README nobody executes.
 * One short completion; the cost is a fraction of a cent.
 */
const apiKey = process.env['ANTHROPIC_API_KEY'];

describe.skipIf(!apiKey)('AnthropicAdapter (live)', () => {
  it('streams a real completion and records usage and cost', { timeout: 60_000 }, async () => {
    const adapter = new AnthropicAdapter({ apiKey: apiKey ?? '' });
    const registry = new AdapterRegistry().register(adapter);

    const response = await collectDeltas(
      registry.stream('anthropic', {
        modelId: 'claude-opus-5',
        system: 'Answer with a single word.',
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'What colour is the sky?' }] }],
        maxOutputTokens: 32,
      }),
    );

    expect(response.text.length).toBeGreaterThan(0);
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);

    const descriptor = await registry.describe('anthropic', 'claude-opus-5');
    const cost = priceUsageFor(descriptor, response.usage, 'measured');
    expect(cost.costUsd).toBeGreaterThan(0);
    expect(cost.basis).toBe('measured');
  });
});

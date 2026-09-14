import { describe, expect, it } from 'vitest';
import { BlindRevealError, BlindRoundResult, runBlindParallel } from './blind';
import { clusterTexts, cosineSimilarity, meanPairwiseSimilarity } from './similarity';

describe('runBlindParallel', () => {
  /**
   * The roadmap's bar for Phase 25: "a test proves no model's context contains
   * another's output before reveal". This is that test, and it checks the
   * property directly rather than trusting the design — every prompt handed to
   * every participant is captured, and then searched for every other
   * participant's answer.
   */
  it('gives no participant another participant’s output', async () => {
    const participants = ['a', 'b', 'c', 'd'];
    const prompts = new Map<string, string>();
    const answers = new Map<string, string>();

    const round = await runBlindParallel(participants, async (participantId) => {
      // Whatever a participant is given is recorded here, verbatim.
      const prompt = `The shared question. You are ${participantId}.`;
      prompts.set(participantId, prompt);
      await Promise.resolve();
      const answer = `SECRET-ANSWER-FROM-${participantId.toUpperCase()}`;
      answers.set(participantId, answer);
      return answer;
    });

    for (const [participantId, prompt] of prompts) {
      for (const [other, answer] of answers) {
        if (other === participantId) continue;
        expect(prompt, `${participantId} saw ${other}`).not.toContain(answer);
      }
    }
    expect(round.answers()).toHaveLength(4);
  });

  it('refuses to reveal before every participant has committed', () => {
    const partial = new BlindRoundResult<string>([
      { participantId: 'a', value: 'done', error: null },
      { participantId: 'b', value: null, error: null },
    ]);
    expect(partial.complete).toBe(false);
    expect(() => partial.reveal()).toThrow(BlindRevealError);
  });

  it('keeps the answers that arrived when one participant fails', async () => {
    const round = await runBlindParallel(['a', 'b'], (participantId) =>
      participantId === 'b'
        ? Promise.reject(new Error('provider is down'))
        : Promise.resolve('an answer'),
    );
    expect(round.complete).toBe(true);
    expect(round.failures.map((failure) => failure.participantId)).toEqual(['b']);
    expect(round.answers()).toEqual([{ participantId: 'a', value: 'an answer' }]);
  });

  it('respects the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await runBlindParallel(
      ['a', 'b', 'c', 'd', 'e', 'f'],
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return 'ok';
      },
      { concurrency: 2 },
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('preserves roster order regardless of which turn finishes first', async () => {
    const delays: Record<string, number> = { a: 3, b: 1, c: 2 };
    const round = await runBlindParallel(['a', 'b', 'c'], async (participantId) => {
      await new Promise((resolve) => {
        setTimeout(resolve, delays[participantId] ?? 0);
      });
      return participantId;
    });
    expect(round.reveal().map((turn) => turn.participantId)).toEqual(['a', 'b', 'c']);
  });
});

describe('similarity', () => {
  it('scores paraphrases high and unrelated text low', () => {
    const a = 'Block-sparse attention preserves perplexity at long context lengths.';
    const b = 'At long context lengths, perplexity is preserved by block-sparse attention.';
    const c = 'The bundled Python runtime is pinned to CPython 3.12.';
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.8);
    expect(cosineSimilarity(a, c)).toBeLessThan(0.2);
  });

  it('groups near-duplicates and keeps every member', () => {
    const clusters = clusterTexts([
      { id: '1', text: 'Sparse attention preserves perplexity at 128k context', source: 'a' },
      { id: '2', text: 'Perplexity is preserved by sparse attention at 128k context', source: 'b' },
      {
        id: '3',
        text: 'Retrieval accuracy degrades before aggregate perplexity does',
        source: 'c',
      },
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.sources).toEqual(['a', 'b']);
    expect(clusters[0]?.members).toHaveLength(2);
  });

  it('scores empty or unrelated bags as zero rather than throwing', () => {
    expect(cosineSimilarity('', 'anything')).toBe(0);
    expect(meanPairwiseSimilarity([])).toBe(0);
    expect(meanPairwiseSimilarity(['only one'])).toBe(0);
  });
});

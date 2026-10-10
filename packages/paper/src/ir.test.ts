import { describe, expect, it } from 'vitest';
import { figuresIn, labelsIn, sentencesOf } from './ir';
import { sampleDocument } from './test-support';

describe('reading prose', () => {
  it('splits a paragraph into sentences without splitting a number or an abbreviation mid-way', () => {
    expect(
      sentencesOf(
        'C1 holds at n = 1.5e6. The error is 0.01, i.e. small! Does C2 follow? (It does not.)',
      ),
    ).toEqual([
      'C1 holds at n = 1.5e6.',
      'The error is 0.01, i.e. small!',
      'Does C2 follow?',
      '(It does not.)',
    ]);
    expect(sentencesOf('  ')).toEqual([]);
  });

  it('finds the claim labels a sentence cites, once each', () => {
    expect(labelsIn('C3 stands; C2 was refuted by the test against C2, and H1 survives.')).toEqual([
      'C3',
      'C2',
      'H1',
    ]);
    // A label is a whole word: a model name or a hex string is not one.
    expect(labelsIn('GPT-C3PO ran on AC12 with seed 0xC4.')).toEqual([]);
  });

  it('lists the figures a document includes, in order', () => {
    expect(figuresIn(sampleDocument()).map((figure) => figure.file)).toEqual([
      'figures/figure-1.pdf',
    ]);
  });
});

import type { PaperDocument } from './ir';

export const SAMPLE_CLAIM = '55555555-5555-4555-8555-555555555555';
export const SAMPLE_REFUTED = '55555555-5555-4555-8555-555555555556';
export const SAMPLE_ARTIFACT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/**
 * A small document with one of everything, and with the characters a model
 * actually writes: LaTeX's own specials, a percent sign, an underscore, an
 * arrow. Typesetting it is the test that the emitter escapes what it is given.
 */
export function sampleDocument(figureFile = 'figures/figure-1.pdf'): PaperDocument {
  return {
    sessionId: '11111111-1111-4111-8111-111111111111',
    title: 'Estimating pi by sampling: 100% of runs & what they show',
    question: 'Can Monte Carlo sampling estimate pi to two decimal places?',
    authors: [
      { name: 'anthropic/claude-opus-5', detail: 'claude-opus-5-20260401' },
      { name: 'openai/gpt-5', detail: 'version not reported' },
      { name: 'ollama/qwen_3', detail: 'sha256:9f2c' },
    ],
    abstract: [
      {
        text: 'This is the record of one research session on the question: can sampling estimate pi?',
        asserts: false,
        claimIds: [],
      },
      {
        text: 'Of 2 findings, 1 is supported and 1 refuted.',
        asserts: false,
        claimIds: [],
      },
    ],
    sections: [
      {
        id: 'question',
        title: 'Question',
        blocks: [
          {
            kind: 'paragraph',
            sentences: [
              { text: 'This record answers one question:', asserts: false, claimIds: [] },
            ],
          },
          {
            kind: 'quote',
            text: 'Can sampling estimate pi?\n\n1. Scope: n ≤ 10^6 samples\n2. Out of scope: {quasi-random} sequences & $costly$ methods',
            attribution: 'the Charter',
          },
        ],
      },
      {
        id: 'method',
        title: 'Method',
        blocks: [
          {
            kind: 'code',
            caption: 'The script, exactly as run (seed 7)',
            text: 'import numpy as np\nrng = np.random.default_rng()\nxy = rng.random((100_000, 2))\nprint(f"pi ~ {4 * (np.sum(xy**2, axis=1) <= 1).mean():.4f}")  # 100% reproducible\n',
          },
          {
            kind: 'facts',
            title: 'The run',
            facts: [
              { term: 'Execution', value: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', mono: true },
              { term: 'Outcome', value: 'ok, exit code 0' },
              { term: 'Environment lock', value: '10c4'.repeat(16), mono: true },
            ],
          },
        ],
      },
      {
        id: 'findings',
        title: 'Findings',
        blocks: [
          {
            kind: 'finding',
            label: 'C1',
            claimId: SAMPLE_CLAIM,
            claimType: 'EMPIRICAL',
            status: 'supported',
            statement: 'With 10^5 samples the estimate is within 0.01 of pi → two places hold.',
          },
          {
            kind: 'figure',
            artifactId: SAMPLE_ARTIFACT,
            file: figureFile,
            hash: 'f1'.repeat(32),
            title: 'Error against sample_count',
            labels: ['C1'],
          },
          {
            kind: 'finding',
            label: 'C2',
            claimId: SAMPLE_REFUTED,
            claimType: 'EMPIRICAL',
            status: 'refuted',
            statement: 'The error falls as 1/n.',
          },
        ],
      },
      {
        id: 'synthesis',
        title: 'Synthesis',
        blocks: [
          {
            kind: 'paragraph',
            lead: 'What stands',
            sentences: [
              {
                text: 'C1 holds at the sample sizes tried.',
                asserts: true,
                claimIds: [SAMPLE_CLAIM],
              },
              {
                text: 'C2 does not: the error falls as 1/sqrt(n) [1].',
                asserts: true,
                claimIds: [SAMPLE_REFUTED],
              },
            ],
          },
        ],
      },
    ],
    appendix: [
      {
        id: 'provenance',
        title: 'Provenance',
        blocks: [
          {
            kind: 'facts',
            facts: [
              { term: 'Event-log head', value: 'ab'.repeat(32), mono: true },
              { term: 'Events', value: '412' },
            ],
          },
        ],
      },
    ],
    references: ['Metropolis & Ulam, The Monte Carlo Method, 1949. doi:10.2307/2280232'],
    labels: [
      { label: 'C1', claimId: SAMPLE_CLAIM },
      { label: 'C2', claimId: SAMPLE_REFUTED },
    ],
  };
}

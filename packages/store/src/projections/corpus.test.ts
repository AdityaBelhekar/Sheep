import { describe, expect, it } from 'vitest';
import { domainEvent, type Source } from '@sheep/core';
import { EVENT_FIXTURES, RETRIEVAL_ID, SESSION_ID } from '@sheep/core/fixtures';
import { openSheepStore, type SheepStore } from '../store';
import { TESTABLE_DRIVERS, useTempDir } from '../test-support';
import { clusterCorpus, DIMENSIONS, embed, searchCorpus, similarity } from './corpus';

const tempDir = useTempDir('sheep-corpus-');

const uuid = (n: number): string => `c0c0c0c0-c0c0-4c0c-8c0c-${String(n).padStart(12, '0')}`;
const [TEMPLATE] = EVENT_FIXTURES['retrieval.recorded'].sources as [Source];

const source = (n: number, title: string, abstract: string | null): Source => ({
  ...TEMPLATE,
  sourceId: uuid(n),
  externalId: `x${String(n)}`,
  title,
  abstract,
});

const ATTENTION =
  'The dominant sequence transduction models are based on recurrent networks. We propose the Transformer, based solely on attention mechanisms.';

/** A session with literature, claims and turns about two unrelated subjects. */
function seeded(dir: string, driver: (typeof TESTABLE_DRIVERS)[number]): SheepStore {
  const store = openSheepStore({ dataDir: dir, driver });
  store.record([
    domainEvent('session.created', {
      sessionId: SESSION_ID,
      title: 'Sparse attention',
      question: 'Does block-sparse attention preserve perplexity?',
    }),
    domainEvent('retrieval.recorded', {
      ...EVENT_FIXTURES['retrieval.recorded'],
      retrievalId: RETRIEVAL_ID,
      sources: [
        source(1, 'Attention Is All You Need', ATTENTION),
        // The same paper as another provider lists it: retitled case, abstract trimmed.
        source(
          2,
          'Attention is all you need',
          ATTENTION.replace(' We propose', ' We propose a network,'),
        ),
        source(
          3,
          'Monte Carlo estimation of pi by random sampling',
          'Points are sampled uniformly in the unit square to estimate pi.',
        ),
        source(4, 'A survey of protein folding', null),
      ],
    }),
    domainEvent('claim.recorded', {
      sessionId: SESSION_ID,
      claimId: uuid(10),
      claimType: 'CONJECTURE',
      statement: 'Block-sparse attention preserves perplexity at long context.',
    }),
    domainEvent('claim.recorded', {
      sessionId: SESSION_ID,
      claimId: uuid(11),
      claimType: 'CONJECTURE',
      statement: 'Random sampling estimates pi to two decimal places.',
    }),
    domainEvent('message.recorded', {
      sessionId: SESSION_ID,
      messageId: uuid(20),
      author: { kind: 'HUMAN' },
      body: { kind: 'text', text: 'How many samples does the pi estimate need to converge?' },
    }),
  ]);
  return store;
}

describe('hashed n-gram vectors', () => {
  it('are unit vectors, the same every time, and zero only for nothing', () => {
    const vector = embed('Block-sparse attention preserves perplexity.');
    expect(vector).toHaveLength(DIMENSIONS);
    expect(similarity(vector, vector)).toBeCloseTo(1, 5);
    expect([...embed('Block-sparse attention preserves perplexity.')]).toEqual([...vector]);
    expect([...embed('  the of and  ')].every((value) => value === 0)).toBe(true);
  });

  it('put texts that share words and phrasing closer than texts that do not', () => {
    const base = embed('Monte Carlo sampling estimates pi from random points.');
    const near = similarity(
      base,
      embed('Random points and Monte Carlo sampling give an estimate of pi.'),
    );
    const far = similarity(base, embed('Transformers rely on attention instead of recurrence.'));
    expect(near).toBeGreaterThan(0.3);
    expect(Math.abs(far)).toBeLessThan(0.1);
    // Case, punctuation and width do not make a text a different text.
    expect(
      similarity(base, embed('MONTE CARLO sampling estimates π… pi, from random points!')),
    ).toBeGreaterThan(0.85);
  });
});

describe.each(TESTABLE_DRIVERS)('the corpus index on %s', (driver) => {
  it('finds what a query is about across sources, claims and turns, best first', () => {
    const store = seeded(tempDir(), driver);
    try {
      const hits = searchCorpus(store.db, SESSION_ID, 'estimating pi with random sampling');
      expect(hits.map((hit) => [hit.kind, hit.refId])).toEqual([
        ['source', uuid(3)],
        ['claim', uuid(11)],
        ['message', uuid(20)],
      ]);
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
      expect(hits[0]!.preview).toMatch(/^Monte Carlo estimation of pi/);

      // Narrowed to one kind, and to nothing at all when nothing matches.
      expect(
        searchCorpus(store.db, SESSION_ID, 'attention', { kinds: ['claim'] }).map(
          (hit) => hit.refId,
        ),
      ).toEqual([uuid(10)]);
      expect(searchCorpus(store.db, SESSION_ID, 'zebrafish hippocampus')).toEqual([]);
      expect(searchCorpus(store.db, uuid(99), 'pi')).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('groups the same paper from two providers, and nothing else with it', () => {
    const store = seeded(tempDir(), driver);
    try {
      expect(clusterCorpus(store.db, SESSION_ID, 'source')).toEqual([
        [uuid(1), uuid(2)],
        [uuid(3)],
        [uuid(4)],
      ]);
      // Loosened far enough, everything is one topic; tightened, nothing is a duplicate.
      expect(clusterCorpus(store.db, SESSION_ID, 'source', -1)).toHaveLength(1);
      expect(clusterCorpus(store.db, SESSION_ID, 'source', 0.999)).toHaveLength(4);
    } finally {
      store.close();
    }
  });

  it('is rebuilt from the log alone, to the same answers', () => {
    const store = seeded(tempDir(), driver);
    try {
      const before = searchCorpus(store.db, SESSION_ID, 'attention mechanisms transformer');
      expect(before.length).toBeGreaterThan(1);
      store.db.exec('DROP TABLE corpus');
      store.projections.ensure();

      expect(searchCorpus(store.db, SESSION_ID, 'attention mechanisms transformer')).toEqual(
        before,
      );
    } finally {
      store.close();
    }
  });
});

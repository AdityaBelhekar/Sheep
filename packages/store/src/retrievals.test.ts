import { describe, expect, it } from 'vitest';
import { domainEvent, type Source } from '@sheep/core';
import { EVENT_FIXTURES, RETRIEVAL_ID, SESSION_ID, SOURCE_ID } from '@sheep/core/fixtures';
import { getSource, listRetrievals, listSources } from './projections/retrievals';
import { recordRetrieval, retrievalBlobRef, type FinishedRetrieval } from './retrievals';
import { openSheepStore, type SheepStore } from './store';
import { TESTABLE_DRIVERS, useTempDir } from './test-support';

const tempDir = useTempDir('sheep-retrievals-');

const BODY = '<feed><entry>…what arXiv actually sent…</entry></feed>';
const [SOURCE] = EVENT_FIXTURES['retrieval.recorded'].sources as [Source];
const SECOND: Source = {
  ...SOURCE,
  sourceId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdc2',
  externalId: '2008.02623v2',
  title: 'Quantum circuit to estimate pi',
  abstract: null,
};

const finished = (overrides: Partial<FinishedRetrieval> = {}): FinishedRetrieval => ({
  retrievalId: RETRIEVAL_ID,
  provider: 'arxiv',
  query: 'attention',
  requestUrl: 'https://export.arxiv.org/api/query?search_query=all%3Aattention',
  body: BODY,
  sources: [SOURCE, SECOND],
  ...overrides,
});

function withSession(dir: string, driver: (typeof TESTABLE_DRIVERS)[number]): SheepStore {
  const store = openSheepStore({ dataDir: dir, driver });
  store.record([
    domainEvent('session.created', {
      sessionId: SESSION_ID,
      title: 'Sparse attention',
      question: 'Does block-sparse attention preserve perplexity?',
    }),
  ]);
  return store;
}

describe.each(TESTABLE_DRIVERS)('retrieval records on %s', (driver) => {
  it('keeps the provider’s response by content address, and each source as a row of its own', () => {
    const store = withSession(tempDir(), driver);
    try {
      const record = recordRetrieval(store, SESSION_ID, finished());

      expect(record).toMatchObject({
        sessionId: SESSION_ID,
        retrievalId: RETRIEVAL_ID,
        provider: 'arxiv',
        query: 'attention',
      });
      expect(store.blobs.readText(record.snapshotHash)).toBe(BODY);
      expect(store.blobs.heldBy(retrievalBlobRef(RETRIEVAL_ID))).toEqual([record.snapshotHash]);
      expect(store.blobs.gc().removed).toEqual([]);

      // In the order the provider ranked them.
      expect(listSources(store.db, SESSION_ID).map((source) => source.title)).toEqual([
        'Attention Is All You Need',
        'Quantum circuit to estimate pi',
      ]);
      expect(getSource(store.db, SOURCE_ID)).toMatchObject({
        retrievalId: RETRIEVAL_ID,
        sessionId: SESSION_ID,
        externalId: '1706.03762v7',
      });
      expect(getSource(store.db, RETRIEVAL_ID)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('records a search that found nothing, since that is what happened', () => {
    const store = withSession(tempDir(), driver);
    try {
      recordRetrieval(store, SESSION_ID, finished({ sources: [] }));
      expect(listRetrievals(store.db, SESSION_ID)).toHaveLength(1);
      expect(listSources(store.db, SESSION_ID)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('leaves nothing held when the event is refused', () => {
    const store = withSession(tempDir(), driver);
    try {
      expect(() =>
        recordRetrieval(store, SESSION_ID, finished({ requestUrl: 'not a url' })),
      ).toThrow();
      expect(store.blobs.heldBy(retrievalBlobRef(RETRIEVAL_ID))).toEqual([]);
      expect(listRetrievals(store.db, SESSION_ID)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('rebuilds both tables from the log alone', () => {
    const store = withSession(tempDir(), driver);
    try {
      const record = recordRetrieval(store, SESSION_ID, finished());
      const sources = listSources(store.db, SESSION_ID);
      store.db.exec('DROP TABLE sources; DROP TABLE retrievals');
      store.projections.ensure();

      expect(listRetrievals(store.db, SESSION_ID)).toEqual([record]);
      expect(listSources(store.db, SESSION_ID)).toEqual(sources);
    } finally {
      store.close();
    }
  });
});

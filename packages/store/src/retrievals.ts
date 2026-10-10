import {
  domainEvent,
  type RetrievalProvider,
  type RetrievalRecord,
  type Source,
} from '@sheep/core';
import type { BlobRef } from './cas/blob-store';
import { listRetrievals } from './projections/retrievals';
import type { SheepStore } from './store';

/**
 * A finished literature search, as a client hands it over.
 *
 * Declared here rather than imported: the store does not depend on any client,
 * and anything shaped like this can be recorded.
 */
export interface FinishedRetrieval {
  readonly retrievalId: string;
  readonly provider: RetrievalProvider;
  readonly query: string;
  readonly requestUrl: string;
  /** The provider's response, exactly as received. */
  readonly body: string;
  readonly sources: readonly Source[];
}

/** Who holds a search's snapshot. Releasing it frees the blob for collection. */
export function retrievalBlobRef(retrievalId: string): BlobRef {
  return { kind: 'retrieval', id: retrievalId };
}

/**
 * Makes a search permanent: the provider's raw response goes into the
 * content-addressed store, and one `retrieval.recorded` event names it by hash
 * beside every source read out of it.
 *
 * The snapshot is the evidence that the sources are what the provider said
 * and not what something later claimed it said. Bytes before the event, and
 * released again if the event is refused, as for every other record.
 */
export function recordRetrieval(
  store: SheepStore,
  sessionId: string,
  retrieval: FinishedRetrieval,
): RetrievalRecord {
  const { retrievalId } = retrieval;
  const ref = retrievalBlobRef(retrievalId);
  try {
    store.record([
      domainEvent('retrieval.recorded', {
        sessionId,
        retrievalId,
        provider: retrieval.provider,
        query: retrieval.query,
        requestUrl: retrieval.requestUrl,
        snapshotHash: store.blobs.put(retrieval.body, ref).hash,
        sources: [...retrieval.sources],
      }),
    ]);
  } catch (error) {
    store.blobs.releaseAll(ref);
    throw error;
  }

  const recorded = listRetrievals(store.db, sessionId).find(
    (entry) => entry.retrievalId === retrievalId,
  );
  if (!recorded) throw new Error(`retrieval ${retrievalId} was recorded but not projected`);
  return recorded;
}

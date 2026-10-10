import { randomUUID } from 'node:crypto';
import type { IpcRequest, IpcResponse } from '@sheep/ipc';
import { admitSource, searchLiterature } from '@sheep/retrieval';
import {
  clusterCorpus,
  getSession,
  listSources,
  readLedger,
  recordRetrieval,
  searchCorpus,
} from '@sheep/store';
import { getStore } from './store';

/**
 * Main's side of the literature: search a provider, admit what comes back, and
 * write the search down.
 *
 * A source exists in a session only by coming through here. It is given its id
 * here, cleaned of hidden text and scanned here, and recorded with the raw
 * response it was read from — so the id a `CITED` claim points at is always
 * the id of something a provider actually returned.
 */

let origin: string | undefined;

/**
 * Points every provider at another host. The launch check uses it to search a
 * server on loopback instead of the internet: the client, the parser, the
 * quarantine and the record are all the ones that ship.
 */
export function setLiteratureOrigin(url: string | undefined): void {
  origin = url;
}

/** A session's sources, the claims that cite each, and which of them are the same work. */
export function readLiterature(sessionId: string): IpcResponse<'sheep:literature-list'> {
  const store = getStore();
  const sources = listSources(store.db, sessionId);
  const claims = readLedger(store.events, sessionId).claims();
  return {
    sources,
    citations: sources.flatMap(({ sourceId }) => {
      const claimIds = claims
        .filter((claim) =>
          claim.support.some(
            (evidence) => evidence.kind === 'CITATION' && evidence.ref === sourceId,
          ),
        )
        .map((claim) => claim.claimId);
      return claimIds.length > 0 ? [{ sourceId, claimIds }] : [];
    }),
    // Two providers, or two searches, returning one paper: grouped, never merged.
    duplicates: clusterCorpus(store.db, sessionId, 'source').filter((group) => group.length > 1),
  };
}

export async function searchForLiterature(
  request: IpcRequest<'sheep:literature-search'>,
): Promise<IpcResponse<'sheep:literature-search'>> {
  const store = getStore();
  if (!getSession(store.db, request.sessionId)) {
    throw new Error(`unknown session: ${request.sessionId}`);
  }

  const result = await searchLiterature(request.provider, request.query, {
    ...(origin === undefined ? {} : { baseUrl: origin }),
  });
  const retrieval = recordRetrieval(store, request.sessionId, {
    retrievalId: randomUUID(),
    provider: result.provider,
    query: result.query,
    requestUrl: result.requestUrl,
    body: result.body,
    sources: result.sources.map((found) => admitSource(found, randomUUID())),
  });
  return {
    retrievalId: retrieval.retrievalId,
    found: retrieval.sources.map((source) => source.sourceId),
    ...readLiterature(request.sessionId),
  };
}

export function searchSession(
  request: IpcRequest<'sheep:corpus-search'>,
): IpcResponse<'sheep:corpus-search'> {
  return { hits: searchCorpus(getStore().db, request.sessionId, request.query, { limit: 12 }) };
}

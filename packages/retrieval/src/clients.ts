import { MAX_ABSTRACT_LENGTH, type RetrievalProvider, type Source } from '@sheep/core';
import { plainText } from './text';

/**
 * The literature clients: arXiv, Semantic Scholar and Crossref.
 *
 * Each is one GET against a public search API, and each answers in its own
 * format. What comes back from here is the same for all three: the exact
 * request, the response byte for byte — which is what gets stored — and the
 * sources read out of it, as plain text.
 *
 * These are the only places Sheep reads from the open internet, and they only
 * read. Nothing about the session leaves except the query the person typed.
 * No key is sent and no account is needed; a provider that rate-limits says
 * so, and the answer to that is to wait, not to retry in a loop.
 */

/** A source as a provider described it, before it is given an id of its own. */
export type FoundSource = Omit<Source, 'sourceId' | 'flags'>;

export interface SearchResult {
  readonly provider: RetrievalProvider;
  readonly query: string;
  readonly requestUrl: string;
  /** The response exactly as received. */
  readonly body: string;
  readonly sources: readonly FoundSource[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SearchOptions {
  /** How many results to ask for. 1–25; default 8. */
  readonly limit?: number;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
  /** Replaces the provider's origin. For tests and the launch check. */
  readonly baseUrl?: string;
}

export class RetrievalError extends Error {
  constructor(
    readonly provider: RetrievalProvider,
    /** The HTTP status, or 0 when no response arrived at all. */
    readonly status: number,
    message: string,
  ) {
    super(`${PROVIDERS[provider].label}: ${message}`);
    this.name = 'RetrievalError';
  }
}

const TIMEOUT_MS = 30_000;
const TITLE_LIMIT = 500;

const httpUrl = (candidate: unknown, fallback: string): string =>
  typeof candidate === 'string' && /^https?:\/\/\S+$/i.test(candidate)
    ? candidate.slice(0, 1_000)
    : fallback;

const text = (value: unknown, limit: number): string | null => {
  if (typeof value !== 'string') return null;
  const cleaned = plainText(value, limit);
  return cleaned === '' ? null : cleaned;
};

const yearOf = (value: unknown): number | null => {
  const year = Number(String(value ?? '').slice(0, 4));
  return Number.isInteger(year) && year >= 1000 && year <= 3000 ? year : null;
};

/** One tag's content out of a fragment of Atom. arXiv's feed is regular enough for this. */
const tag = (xml: string, name: string): string | undefined =>
  new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];

export function parseArxiv(xml: string): FoundSource[] {
  const sources: FoundSource[] = [];
  for (const [, entry = ''] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = /arxiv\.org\/abs\/([^\s<]+)/.exec(tag(entry, 'id') ?? '')?.[1];
    const title = text(tag(entry, 'title'), TITLE_LIMIT);
    if (id === undefined || title === null) continue;
    sources.push({
      provider: 'arxiv',
      externalId: id.slice(0, 300),
      title,
      authors: [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)]
        .flatMap(([, name]) => text(name, 200) ?? [])
        .slice(0, 50),
      year: yearOf(tag(entry, 'published')),
      venue: text(tag(entry, 'arxiv:journal_ref'), 300) ?? 'arXiv',
      doi: text(tag(entry, 'arxiv:doi'), 300),
      url: `https://arxiv.org/abs/${encodeURI(id)}`,
      abstract: text(tag(entry, 'summary'), MAX_ABSTRACT_LENGTH),
    });
  }
  return sources;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  typeof value === 'object' && value !== null ? (value as Json) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function parseSemanticScholar(body: string): FoundSource[] {
  return list(record(JSON.parse(body))['data']).flatMap((item): FoundSource[] => {
    const paper = record(item);
    const id = text(paper['paperId'], 300);
    const title = text(paper['title'], TITLE_LIMIT);
    if (id === null || title === null) return [];
    return [
      {
        provider: 'semantic-scholar',
        externalId: id,
        title,
        authors: list(paper['authors'])
          .flatMap((author) => text(record(author)['name'], 200) ?? [])
          .slice(0, 50),
        year: yearOf(paper['year']),
        venue: text(paper['venue'], 300),
        doi: text(record(paper['externalIds'])['DOI'], 300),
        url: httpUrl(
          paper['url'],
          `https://www.semanticscholar.org/paper/${encodeURIComponent(id)}`,
        ),
        abstract: text(paper['abstract'], MAX_ABSTRACT_LENGTH),
      },
    ];
  });
}

export function parseCrossref(body: string): FoundSource[] {
  return list(record(record(JSON.parse(body))['message'])['items']).flatMap(
    (item): FoundSource[] => {
      const work = record(item);
      const doi = text(work['DOI'], 300);
      const title = text(list(work['title'])[0], TITLE_LIMIT);
      if (doi === null || title === null) return [];
      return [
        {
          provider: 'crossref',
          externalId: doi,
          title,
          authors: list(work['author'])
            .flatMap((author) => {
              const person = record(author);
              const name = [person['given'], person['family']]
                .filter((part) => typeof part === 'string')
                .join(' ');
              return text(name === '' ? person['name'] : name, 200) ?? [];
            })
            .slice(0, 50),
          year: yearOf(list(list(record(work['issued'])['date-parts'])[0])[0]),
          venue: text(list(work['container-title'])[0], 300),
          doi,
          url: `https://doi.org/${encodeURI(doi)}`,
          abstract: text(work['abstract'], MAX_ABSTRACT_LENGTH),
        },
      ];
    },
  );
}

interface Provider {
  readonly label: string;
  readonly origin: string;
  path(query: string, limit: number): string;
  parse(body: string): FoundSource[];
}

const PROVIDERS: Readonly<Record<RetrievalProvider, Provider>> = {
  arxiv: {
    label: 'arXiv',
    origin: 'https://export.arxiv.org',
    path: (query, limit) =>
      `/api/query?${new URLSearchParams({
        search_query: `all:${query}`,
        start: '0',
        max_results: String(limit),
      }).toString()}`,
    parse: parseArxiv,
  },
  'semantic-scholar': {
    label: 'Semantic Scholar',
    origin: 'https://api.semanticscholar.org',
    path: (query, limit) =>
      `/graph/v1/paper/search?${new URLSearchParams({
        query,
        limit: String(limit),
        fields: 'title,abstract,authors,year,venue,externalIds,url',
      }).toString()}`,
    parse: parseSemanticScholar,
  },
  crossref: {
    label: 'Crossref',
    origin: 'https://api.crossref.org',
    path: (query, limit) =>
      `/works?${new URLSearchParams({
        query,
        rows: String(limit),
        select: 'DOI,title,author,issued,container-title,abstract,URL,type',
      }).toString()}`,
    parse: parseCrossref,
  },
};

export function providerLabel(provider: RetrievalProvider): string {
  return PROVIDERS[provider].label;
}

/**
 * Searches one provider.
 *
 * A response that is not a success, or cannot be read as what the provider
 * promises, is a `RetrievalError` saying which; nothing is returned that was
 * not actually found.
 */
export async function searchLiterature(
  provider: RetrievalProvider,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const { label, origin, path, parse } = PROVIDERS[provider];
  const limit = Math.min(25, Math.max(1, Math.trunc(options.limit ?? 8)));
  const requestUrl = `${options.baseUrl ?? origin}${path(query.trim(), limit)}`;
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  let body: string;
  try {
    response = await send(requestUrl, {
      headers: { accept: 'application/json, application/atom+xml', 'user-agent': 'Sheep' },
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    body = await response.text();
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new RetrievalError(
      provider,
      0,
      timeout.aborted
        ? `no answer in ${String(TIMEOUT_MS / 1000)} seconds`
        : `could not be reached (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }

  if (response.status === 429) {
    throw new RetrievalError(
      provider,
      429,
      'is rate-limiting requests from this address; wait a little and search again',
    );
  }
  if (!response.ok) {
    throw new RetrievalError(provider, response.status, `answered ${String(response.status)}`);
  }

  try {
    return { provider, query: query.trim(), requestUrl, body, sources: parse(body) };
  } catch {
    throw new RetrievalError(
      provider,
      response.status,
      `sent something that is not a ${label} result`,
    );
  }
}

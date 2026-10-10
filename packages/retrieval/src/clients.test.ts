import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceSchema } from '@sheep/core';
import {
  parseArxiv,
  parseCrossref,
  parseSemanticScholar,
  RetrievalError,
  searchLiterature,
  type FetchLike,
} from './clients';
import { plainText } from './text';

/**
 * arxiv.xml and crossref.json are responses the real services gave, recorded
 * once. semantic-scholar-429.json is too — it is what that service answered at
 * the time — and semantic-scholar.json is written by hand to its documented
 * shape, with the rows a parser has to survive.
 */
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8');

const SOURCE_ID = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';

/** A provider that answers every request with one canned response, and remembers what it was asked. */
function answering(body: string, status = 200): { fetch: FetchLike; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetch: (input) => {
      asked.push(input);
      return Promise.resolve(new Response(body, { status }));
    },
  };
}

describe('reading a provider’s response', () => {
  it('reads arXiv’s Atom feed', () => {
    const [source] = parseArxiv(fixture('arxiv.xml'));
    expect(source).toMatchObject({
      provider: 'arxiv',
      externalId: '2008.02623v2',
      title: 'Quantum circuit to estimate pi using quantum amplitude estimation',
      year: 2020,
      url: 'https://arxiv.org/abs/2008.02623v2',
    });
    expect(source!.authors[0]).toBe('Takuma Noto');
    expect(source!.abstract).toMatch(/^This study presents a quantum circuit/);
    // One line of text: the feed's own line breaks and entities are gone.
    expect(source!.abstract).not.toMatch(/\n|&amp;|</);
  });

  it('reads Crossref’s works, dropping the markup in their abstracts', () => {
    const sources = parseCrossref(fixture('crossref.json'));
    expect(sources).toHaveLength(3);
    const [first] = sources;
    expect(first).toMatchObject({
      provider: 'crossref',
      externalId: '10.2337/db26-1882-p',
      doi: '10.2337/db26-1882-p',
      venue: 'Diabetes',
      year: 2026,
      url: 'https://doi.org/10.2337/db26-1882-p',
      authors: ['SAM GLASSENBERG'],
    });
    expect(first!.abstract).toMatch(/^Introduction and Objective:/);
    expect(first!.abstract).not.toContain('jats');
  });

  it('reads Semantic Scholar’s papers, and survives the rows that are not ones', () => {
    const sources = parseSemanticScholar(fixture('semantic-scholar.json'));
    expect(sources.map((source) => source.title)).toEqual([
      'Attention is All you Need',
      'A paper with no abstract, no year and a link that is not one',
    ]);
    expect(sources[0]).toMatchObject({
      doi: '10.48550/arXiv.1706.03762',
      year: 2017,
      venue: 'Neural Information Processing Systems',
      authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
    });
    // A link that is not http is not kept as a link.
    expect(sources[1]).toMatchObject({
      abstract: null,
      year: null,
      venue: null,
      authors: [],
      url: 'https://www.semanticscholar.org/paper/0000000000000000000000000000000000000001',
    });
  });

  it('produces only sources the schema accepts', () => {
    const found = [
      ...parseArxiv(fixture('arxiv.xml')),
      ...parseCrossref(fixture('crossref.json')),
      ...parseSemanticScholar(fixture('semantic-scholar.json')),
    ];
    expect(found.length).toBeGreaterThan(4);
    for (const source of found) {
      expect(() => sourceSchema.parse({ ...source, sourceId: SOURCE_ID, flags: [] })).not.toThrow();
    }
  });

  it('reduces markup to text, and cuts it where it says it does', () => {
    expect(plainText('  <jats:p>A &amp; B</jats:p>\n\n<b>C</b> &#x3c0; &lt;script&gt; ', 100)).toBe(
      'A & B C π <script>',
    );
    expect(plainText('word '.repeat(50), 22)).toBe('word word word word wo […]');
  });
});

describe('searching', () => {
  it('asks each provider in its own dialect, and returns the response byte for byte', async () => {
    const arxiv = answering(fixture('arxiv.xml'));
    const result = await searchLiterature('arxiv', '  monte carlo pi ', {
      fetch: arxiv.fetch,
      limit: 3,
    });

    expect(arxiv.asked).toEqual([
      'https://export.arxiv.org/api/query?search_query=all%3Amonte+carlo+pi&start=0&max_results=3',
    ]);
    expect(result.requestUrl).toBe(arxiv.asked[0]);
    expect(result.query).toBe('monte carlo pi');
    expect(result.body).toBe(fixture('arxiv.xml'));
    expect(result.sources).toHaveLength(1);

    const crossref = answering(fixture('crossref.json'));
    await searchLiterature('crossref', 'attention', { fetch: crossref.fetch });
    expect(crossref.asked[0]).toMatch(
      /^https:\/\/api\.crossref\.org\/works\?query=attention&rows=8&/,
    );

    const scholar = answering(fixture('semantic-scholar.json'));
    await searchLiterature('semantic-scholar', 'attention', { fetch: scholar.fetch, limit: 500 });
    expect(scholar.asked[0]).toMatch(
      /^https:\/\/api\.semanticscholar\.org\/graph\/v1\/paper\/search\?query=attention&limit=25&/,
    );
  });

  it('says so when a provider is rate-limiting, and does not ask again', async () => {
    const scholar = answering(fixture('semantic-scholar-429.json'), 429);
    const failure = searchLiterature('semantic-scholar', 'attention', { fetch: scholar.fetch });

    await expect(failure).rejects.toThrow(RetrievalError);
    await expect(failure).rejects.toThrow(/Semantic Scholar: is rate-limiting requests/);
    expect(scholar.asked).toHaveLength(1);
  });

  it('reports a failure as a failure, never as an empty result', async () => {
    await expect(
      searchLiterature('crossref', 'x', {
        fetch: answering('<html>bad gateway</html>', 502).fetch,
      }),
    ).rejects.toThrow(/Crossref: answered 502/);
    await expect(
      searchLiterature('crossref', 'x', { fetch: answering('<html>not json</html>').fetch }),
    ).rejects.toThrow(/Crossref: sent something that is not a Crossref result/);
    await expect(
      searchLiterature('arxiv', 'x', {
        fetch: () => Promise.reject(new TypeError('getaddrinfo ENOTFOUND')),
      }),
    ).rejects.toThrow(/arXiv: could not be reached \(getaddrinfo ENOTFOUND\)/);
  });

  it('finds nothing when there is nothing, which is an answer', async () => {
    const empty = '<feed xmlns="http://www.w3.org/2005/Atom"><title>none</title></feed>';
    const result = await searchLiterature('arxiv', 'zxqv', { fetch: answering(empty).fetch });
    expect(result.sources).toEqual([]);
  });
});

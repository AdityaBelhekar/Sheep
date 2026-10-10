import { z } from 'zod';
import { idSchema, sha256Schema, timestampSchema } from './primitives';

/**
 * Literature, as it was actually retrieved.
 *
 * A citation is only worth something if the thing cited exists. So a source is
 * not something a model can name: it is a row that came back from a search
 * Sheep itself made, recorded with the query that found it and the provider's
 * raw response kept by hash. A `CITED` claim points at one of these, and the
 * ledger refuses a citation of anything that was never retrieved.
 *
 * Everything a source says about itself — its title, its authors, its abstract
 * — is text from outside, written by nobody this session can vouch for. It is
 * stored as data and shown as data. `flags` records what a scan found in it
 * that reads like an instruction to a model rather than a description of a
 * paper; a flagged source is still a source, and is labelled wherever shown.
 */

export const RETRIEVAL_PROVIDERS = ['arxiv', 'semantic-scholar', 'crossref'] as const;
export const retrievalProviderSchema = z.enum(RETRIEVAL_PROVIDERS);
export type RetrievalProvider = z.infer<typeof retrievalProviderSchema>;

/** The longest abstract kept. Past this it is cut, and the cut is marked. */
export const MAX_ABSTRACT_LENGTH = 6_000;

export const sourceSchema = z.strictObject({
  sourceId: idSchema,
  provider: retrievalProviderSchema,
  /** The provider's own identifier: an arXiv id, a DOI, a paper id. */
  externalId: z.string().min(1).max(300),
  title: z.string().min(1).max(600),
  authors: z.array(z.string().min(1).max(200)).max(50),
  year: z.number().int().min(1000).max(3000).nullable(),
  venue: z.string().min(1).max(300).nullable(),
  doi: z.string().min(1).max(300).nullable(),
  /** Shown as a link, so a web address and nothing a shell would run. */
  url: z.url({ protocol: /^https?$/ }).max(1_000),
  abstract: z
    .string()
    .max(MAX_ABSTRACT_LENGTH + 40)
    .nullable(),
  /** What the injection scan matched in the title or abstract; empty when nothing. */
  flags: z.array(z.string().min(1).max(80)).max(20),
});
export type Source = z.infer<typeof sourceSchema>;

/** One search: what was asked, of whom, and everything that came back. */
export const retrievalFields = {
  retrievalId: idSchema,
  provider: retrievalProviderSchema,
  query: z.string().min(1).max(500),
  /** The exact request, so the search can be made again. */
  requestUrl: z.url().max(2_000),
  /** The provider's response, byte for byte, in the blob store. */
  snapshotHash: sha256Schema,
  sources: z.array(sourceSchema).max(50),
} as const;

export const retrievalRecordSchema = z.strictObject({
  sessionId: idSchema,
  ...retrievalFields,
  recordedAt: timestampSchema,
});
export type RetrievalRecord = z.infer<typeof retrievalRecordSchema>;

/** A source as it is listed: with the search that found it. */
export const sourceRecordSchema = sourceSchema.extend({
  sessionId: idSchema,
  retrievalId: idSchema,
  recordedAt: timestampSchema,
});
export type SourceRecord = z.infer<typeof sourceRecordSchema>;

/** How a source is cited in running text: `Noto et al. (2020). Title. Venue. doi`. */
export function formatCitation(source: Source): string {
  const [first, ...rest] = source.authors;
  const authors =
    first === undefined
      ? 'Unknown author'
      : rest.length === 0
        ? first
        : rest.length === 1
          ? `${first} and ${rest[0] ?? ''}`
          : `${first} et al.`;
  return [
    `${authors} (${source.year === null ? 'n.d.' : String(source.year)}).`,
    `${source.title.replace(/\.$/, '')}.`,
    ...(source.venue === null ? [] : [`${source.venue}.`]),
    source.doi === null ? source.url : `doi:${source.doi}`,
  ].join(' ');
}

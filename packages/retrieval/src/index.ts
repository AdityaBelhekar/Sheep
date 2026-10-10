/**
 * @sheep/retrieval — Literature search clients, and the quarantine retrieved
 * text is kept in.
 */
export const PACKAGE_NAME = '@sheep/retrieval';

export {
  parseArxiv,
  parseCrossref,
  parseSemanticScholar,
  providerLabel,
  RetrievalError,
  searchLiterature,
  type FetchLike,
  type FoundSource,
  type SearchOptions,
  type SearchResult,
} from './clients';
export { plainText } from './text';

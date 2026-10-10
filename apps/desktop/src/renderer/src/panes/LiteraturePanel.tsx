import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  formatCitation,
  RETRIEVAL_PROVIDERS,
  type RetrievalProvider,
  type SourceRecord,
} from '@sheep/core';
import type { IpcClient, IpcResponse } from '@sheep/ipc';

type Literature = IpcResponse<'sheep:literature-list'>;
type Hits = IpcResponse<'sheep:corpus-search'>['hits'];

const PROVIDER_LABELS: Record<RetrievalProvider, string> = {
  arxiv: 'arXiv',
  'semantic-scholar': 'Semantic Scholar',
  crossref: 'Crossref',
};

const KIND_LABELS: Record<Hits[number]['kind'], string> = {
  message: 'turn',
  claim: 'claim',
  source: 'source',
};

/**
 * Literature: search for it, read it as what it is, and cite it.
 *
 * A source here is text someone outside the session wrote, and is shown as
 * that — as characters, never as markup, with a warning beside any source in
 * which a scan found something addressed to a model. Citing one records a
 * CITED claim, which the ledger lets support other claims and never lets
 * stand as established on its own. A citation can only be of something in
 * this list, because the list is the only thing that was actually retrieved.
 */
export function LiteraturePanel({
  client,
  sessionId,
  onLedgerChanged,
}: {
  client: IpcClient;
  sessionId: string;
  onLedgerChanged: () => void;
}): ReactElement {
  const [literature, setLiterature] = useState<Literature | null>(null);
  const [provider, setProvider] = useState<RetrievalProvider>('arxiv');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fresh, setFresh] = useState<readonly string[]>([]);
  const [within, setWithin] = useState('');
  const [hits, setHits] = useState<Hits | null>(null);

  const load = useCallback(async () => {
    try {
      setLiterature(await client.invoke('sheep:literature-list', { sessionId }));
    } catch (error) {
      setProblem(describe(error));
    }
  }, [client, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const search = async (): Promise<void> => {
    if (busy || query.trim() === '') return;
    setProblem(null);
    setBusy(true);
    try {
      const reply = await client.invoke('sheep:literature-search', {
        sessionId,
        provider,
        query: query.trim(),
      });
      setLiterature(reply);
      setFresh(reply.found);
      if (reply.found.length === 0)
        setProblem(`${PROVIDER_LABELS[provider]} found nothing for that.`);
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const searchWithin = async (): Promise<void> => {
    if (within.trim() === '') {
      setHits(null);
      return;
    }
    try {
      setHits((await client.invoke('sheep:corpus-search', { sessionId, query: within })).hits);
    } catch (error) {
      setProblem(describe(error));
    }
  };

  const cite = async (source: SourceRecord, statement: string): Promise<boolean> => {
    setProblem(null);
    try {
      await client.invoke('sheep:claim-record', {
        sessionId,
        claimType: 'CITED',
        statement,
        support: [{ kind: 'CITATION', ref: source.sourceId }],
      });
      await load();
      onLedgerChanged();
      return true;
    } catch (error) {
      setProblem(describe(error));
      return false;
    }
  };

  const citedBy = (sourceId: string): number =>
    literature?.citations.find((entry) => entry.sourceId === sourceId)?.claimIds.length ?? 0;
  const sameWorkAs = (sourceId: string): number =>
    (literature?.duplicates.find((group) => group.includes(sourceId))?.length ?? 1) - 1;

  return (
    <section
      className="literature"
      data-sheep-literature={literature ? String(literature.sources.length) : undefined}
    >
      <h2 className="calibration__title">Literature</h2>
      <p className="calibration__note">
        Searches go to the provider you choose and carry only the words you type. What comes back is
        recorded with the provider&rsquo;s raw response, and is the only thing a CITED claim can
        point at. A cited claim can support others; it is never established on its own.
      </p>

      <div className="record-claim__row">
        <select
          className="field__input literature__provider"
          aria-label="Provider"
          value={provider}
          onChange={(event) => {
            setProvider(event.target.value as RetrievalProvider);
          }}
        >
          {RETRIEVAL_PROVIDERS.map((option) => (
            <option key={option} value={option}>
              {PROVIDER_LABELS[option]}
            </option>
          ))}
        </select>
        <input
          className="field__input"
          placeholder="Search the literature"
          maxLength={500}
          data-sheep-literature-query
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void search();
          }}
        />
        <button
          type="button"
          className="button"
          data-sheep-literature-search
          disabled={busy || query.trim() === ''}
          onClick={() => {
            void search();
          }}
        >
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>

      {problem !== null && (
        <p className="notice notice--error" role="alert" data-sheep-literature-problem>
          {problem}
        </p>
      )}

      {literature && literature.sources.length > 0 && (
        <ul className="literature__sources">
          {literature.sources.map((source) => (
            <SourceRow
              key={source.sourceId}
              source={source}
              fresh={fresh.includes(source.sourceId)}
              citedBy={citedBy(source.sourceId)}
              sameWorkAs={sameWorkAs(source.sourceId)}
              onCite={(statement) => cite(source, statement)}
            />
          ))}
        </ul>
      )}

      <div className="record-claim__row">
        <input
          className="field__input"
          placeholder="Search this session: turns, claims and sources"
          maxLength={500}
          data-sheep-corpus-query
          value={within}
          onChange={(event) => {
            setWithin(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void searchWithin();
          }}
        />
        <button
          type="button"
          className="button button--quiet"
          data-sheep-corpus-search
          onClick={() => {
            void searchWithin();
          }}
        >
          Find
        </button>
      </div>
      {hits !== null && (
        <ul className="literature__hits" data-sheep-corpus-hits={String(hits.length)}>
          {hits.length === 0 && (
            <li className="lab__muted">Nothing in this session shares those words.</li>
          )}
          {hits.map((hit) => (
            <li key={`${hit.kind}-${hit.refId}`} data-kind={hit.kind}>
              <span className="badge">{KIND_LABELS[hit.kind]}</span> {hit.preview}{' '}
              <code className="lab__muted">
                {hit.refId.slice(0, 8)} · {hit.score.toFixed(2)}
              </code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SourceRow({
  source,
  fresh,
  citedBy,
  sameWorkAs,
  onCite,
}: {
  source: SourceRecord;
  fresh: boolean;
  citedBy: number;
  sameWorkAs: number;
  onCite: (statement: string) => Promise<boolean>;
}): ReactElement {
  const [statement, setStatement] = useState('');
  const flagged = source.flags.length > 0;

  return (
    <li
      className="literature__source"
      data-sheep-source={source.sourceId}
      data-flagged={flagged ? 'true' : 'false'}
      data-fresh={fresh ? 'true' : undefined}
    >
      <div className="literature__head">
        <span className="badge">{PROVIDER_LABELS[source.provider]}</span>
        <strong>{source.title}</strong>
        {citedBy > 0 && (
          <span className="lab__muted" data-sheep-source-cited={String(citedBy)}>
            cited by {citedBy} claim{citedBy === 1 ? '' : 's'}
          </span>
        )}
        {sameWorkAs > 0 && (
          <span className="lab__muted" data-sheep-source-duplicate>
            same work as {sameWorkAs} other result{sameWorkAs === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {/* The citation, the link and the abstract are text a stranger wrote: shown as text. */}
      <p className="literature__citation">{formatCitation(source)}</p>
      <a className="lab__muted" href={source.url} target="_blank" rel="noreferrer noopener">
        {source.url}
      </a>

      {flagged && (
        <p className="notice notice--error" role="alert" data-sheep-source-flags>
          A scan of this source found text that {source.flags.join('; ')}. It reads as an
          instruction to a model rather than a description of the work. It is kept exactly as
          retrieved, fenced off wherever a model sees it, and never acted on.
        </p>
      )}

      {source.abstract !== null && (
        <details>
          <summary className="lab__muted">Abstract — untrusted text, as retrieved</summary>
          <p className="literature__abstract">{source.abstract}</p>
        </details>
      )}

      <div className="record-claim__row">
        <input
          className="field__input"
          placeholder="What does this source say? One sentence, recorded as a CITED claim."
          maxLength={2_000}
          data-sheep-source-statement
          value={statement}
          onChange={(event) => {
            setStatement(event.target.value);
          }}
        />
        <button
          type="button"
          className="button button--quiet"
          data-sheep-source-cite
          disabled={statement.trim() === ''}
          onClick={() => {
            void onCite(statement.trim()).then((recorded) => {
              if (recorded) setStatement('');
            });
          }}
        >
          Cite
        </button>
      </div>
    </li>
  );
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // The reason is the useful part; the IPC wrapping is not.
  return message.replace(/^.*IPC_HANDLER_FAILED: [^ ]+ /, '');
}

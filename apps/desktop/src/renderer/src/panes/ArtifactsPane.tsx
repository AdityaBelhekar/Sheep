import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ARTIFACT_KINDS, type ArtifactKind, type ArtifactRecord, type Claim } from '@sheep/core';
import type { IpcClient, IpcResponse } from '@sheep/ipc';
import { paneById } from '@shared/panes';
import { Formula } from '../components/Formula';
import { PdfPreview } from '../components/PdfPreview';

type Listing = IpcResponse<'sheep:artifacts-list'>;
type Status = IpcResponse<'sheep:artifacts-status'>;
type Rerendering = IpcResponse<'sheep:artifact-rerender'>;

const KINDS: Record<ArtifactKind, { label: string; language: string; starter: string }> = {
  graphviz: {
    label: 'Graphviz',
    language: 'DOT',
    starter: [
      'digraph provenance {',
      '  rankdir=LR;',
      '  node [shape=box, fontname="Helvetica"];',
      '  source -> figure [label="renders to"];',
      '  figure -> claim [label="supports"];',
      '}',
    ].join('\n'),
  },
  mermaid: {
    label: 'Mermaid',
    language: 'Mermaid',
    starter: [
      'flowchart LR',
      '  H[Hypothesis] --> M{Method}',
      '  M -->|run| E[(Execution)]',
      '  E --> C[Claim]',
    ].join('\n'),
  },
  tikz: {
    label: 'TikZ',
    language: 'TikZ — a picture, or a whole LaTeX document',
    starter: [
      String.raw`\node[draw, rounded corners] (claim) {Claim};`,
      String.raw`\node[draw, rounded corners, right=of claim] (run) {Execution};`,
      String.raw`\draw[-{Stealth}] (run) -- node[above] {backs} (claim);`,
    ].join('\n'),
  },
  formula: {
    label: 'Formula',
    language: 'LaTeX mathematics',
    starter: String.raw`H(X) = -\sum_{i} p_i \log p_i`,
  },
  matplotlib: {
    label: 'Matplotlib',
    language: 'Python — every figure left open is kept',
    starter: [
      'import numpy as np',
      'import matplotlib.pyplot as plt',
      '',
      'rng = np.random.default_rng()',
      'fig, ax = plt.subplots(figsize=(5, 3))',
      'ax.plot(np.cumsum(rng.normal(size=200)))',
      'ax.set_xlabel("step")',
      'ax.set_ylabel("position")',
    ].join('\n'),
  },
};

/** What was being written, per kind, kept across navigation as the Lab keeps its script. */
const draft: { kind: ArtifactKind; title: string; sources: Partial<Record<ArtifactKind, string>> } =
  { kind: 'graphviz', title: '', sources: {} };

/**
 * Every figure, diagram and formula in a session, each with what made it.
 *
 * An artifact is shown with its source, the toolchain that rendered it, the
 * run behind it when there is one, and the claims that rest on it. Any of them
 * can be rendered again from that source and compared, file by file, with what
 * was recorded — which is the difference between a figure that can be trusted
 * and one that can be checked.
 */
export function ArtifactsPane({
  client,
  onStoreChanged,
}: {
  client: IpcClient | undefined;
  onStoreChanged: () => void;
}): ReactElement {
  const pane = paneById('artifacts');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [claims, setClaims] = useState<readonly Claim[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [kind, setKind] = useState<ArtifactKind>(draft.kind);
  const [title, setTitle] = useState(draft.title);
  const [source, setSource] = useState(draft.sources[draft.kind] ?? KINDS[draft.kind].starter);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  draft.kind = kind;
  draft.title = title;
  draft.sources[kind] = source;

  useEffect(() => {
    if (!client) return;
    const signal = { cancelled: false };
    // The open session is the shell's, written by the roster panel.
    client
      .invoke('sheep:settings-read', {})
      .then((reply) => {
        if (!signal.cancelled) setSessionId(reply.settings['ui.lastSessionId']);
      })
      .catch(() => {
        // No session preselected; the empty state says what to do.
      });
    client
      .invoke('sheep:artifacts-status', {})
      .then((reply) => {
        if (!signal.cancelled) setStatus(reply);
      })
      .catch(() => {
        // Rendering will say what is wrong when it is tried.
      });
    return () => {
      signal.cancelled = true;
    };
  }, [client]);

  const load = useCallback(async () => {
    if (!client || sessionId === null) return;
    try {
      const [artifacts, ledger] = await Promise.all([
        client.invoke('sheep:artifacts-list', { sessionId }),
        client.invoke('sheep:ledger-get', { sessionId }),
      ]);
      setListing(artifacts);
      setClaims(ledger.claims);
    } catch (error) {
      setProblem(describe(error));
    }
  }, [client, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const chooseKind = (next: ArtifactKind): void => {
    setKind(next);
    setSource(draft.sources[next] ?? KINDS[next].starter);
  };

  const render = async (): Promise<void> => {
    if (!client || sessionId === null || busy) return;
    setProblem(null);
    setBusy(true);
    try {
      const reply = await client.invoke('sheep:artifact-create', {
        sessionId,
        kind,
        title: title.trim() || `Untitled ${KINDS[kind].label.toLowerCase()}`,
        source,
      });
      setListing(reply);
      setSelected(reply.created[0] ?? null);
      onStoreChanged();
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const link = async (artifactId: string, claimId: string): Promise<void> => {
    if (!client || sessionId === null) return;
    setProblem(null);
    try {
      setListing(await client.invoke('sheep:artifact-link', { sessionId, artifactId, claimId }));
      onStoreChanged();
    } catch (error) {
      setProblem(describe(error));
    }
  };

  const claimsOn = (artifactId: string): readonly string[] =>
    listing?.backing.find((entry) => entry.artifactId === artifactId)?.claimIds ?? [];
  const shown = listing?.artifacts.find((artifact) => artifact.artifactId === selected);

  return (
    <section
      className="pane pane--wide"
      data-pane="artifacts"
      data-sheep-artifacts={listing ? String(listing.artifacts.length) : undefined}
    >
      <header className="pane__header">
        <h1 className="pane__title">{pane.label}</h1>
        <p className="pane__summary">{pane.summary}</p>
      </header>

      {!client && <p className="notice notice--error">Artifacts need the preload bridge.</p>}

      {client && status?.available === false && (
        <p className="notice notice--error" role="alert">
          {status.detail}
        </p>
      )}

      {client && sessionId === null && (
        <div className="empty">
          <p className="empty__title">No session is open</p>
          <p className="empty__body">Open a session first.</p>
        </div>
      )}

      {client && sessionId !== null && (
        <div className="verify">
          <div className="verify__compose">
            <div className="button-row" role="tablist" aria-label="Kind of artifact">
              {ARTIFACT_KINDS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  className="button button--quiet"
                  aria-selected={option === kind}
                  data-sheep-artifact-kind={option}
                  onClick={() => {
                    chooseKind(option);
                  }}
                >
                  {KINDS[option].label}
                </button>
              ))}
            </div>
            <label className="field">
              <span className="field__label">Title</span>
              <input
                className="field__input"
                maxLength={200}
                placeholder={`Untitled ${KINDS[kind].label.toLowerCase()}`}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                }}
              />
            </label>
            <label className="field">
              <span className="field__label">Source — {KINDS[kind].language}</span>
              <textarea
                className="field__input field__input--multiline verify__source artifacts__source"
                spellCheck={false}
                data-sheep-artifact-source
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                }}
              />
            </label>
            {kind === 'formula' && source.trim() !== '' && (
              <div className="artifacts__preview">
                <Formula latex={source} source={source} showLatex={false} />
              </div>
            )}
            <div className="button-row">
              <button
                type="button"
                className="button"
                data-sheep-artifact-render
                disabled={busy || source.trim() === ''}
                onClick={() => {
                  void render();
                }}
              >
                {busy ? 'Rendering…' : 'Render and record'}
              </button>
              {status?.available && <span className="lab__muted">{status.detail}</span>}
            </div>
            {problem !== null && (
              <pre className="notice notice--error artifacts__problem" role="alert">
                {problem}
              </pre>
            )}
          </div>

          <div className="verify__result">
            {shown ? (
              <Detail
                key={shown.artifactId}
                client={client}
                artifact={shown}
                claimIds={claimsOn(shown.artifactId)}
                claims={claims}
                onLink={(claimId) => {
                  void link(shown.artifactId, claimId);
                }}
                onRestored={onStoreChanged}
              />
            ) : (
              <div className="empty">
                <p className="empty__title">Nothing selected</p>
                <p className="empty__body">
                  Render a source, or open an artifact below. Figures saved by a Lab run or by the
                  protocol&rsquo;s own experiments are listed here too.
                </p>
              </div>
            )}
          </div>

          {listing && listing.artifacts.length > 0 && (
            <div className="lab__history">
              <h2 className="calibration__title">Artifacts in this session</h2>
              <ul className="lab__runs">
                {listing.artifacts.map((artifact) => (
                  <li key={artifact.artifactId}>
                    <button
                      type="button"
                      className="lab__run-row"
                      data-sheep-artifact={artifact.artifactId}
                      data-kind={artifact.kind}
                      aria-current={artifact.artifactId === selected ? 'true' : undefined}
                      onClick={() => {
                        setSelected(artifact.artifactId);
                      }}
                    >
                      <span className="badge">{KINDS[artifact.kind].label}</span>
                      <span>{artifact.title}</span>
                      <span className="lab__muted">
                        {artifact.outputs.map((output) => extensionOf(output.path)).join(' · ')}
                      </span>
                      {claimsOn(artifact.artifactId).length > 0 && (
                        <span className="lab__muted">
                          supports {claimsOn(artifact.artifactId).length} claim
                          {claimsOn(artifact.artifactId).length === 1 ? '' : 's'}
                        </span>
                      )}
                      <code className="lab__muted">{artifact.artifactId.slice(0, 8)}</code>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** One artifact: what it looks like, what made it, and whether it still comes out the same. */
function Detail({
  client,
  artifact,
  claimIds,
  claims,
  onLink,
  onRestored,
}: {
  client: IpcClient;
  artifact: ArtifactRecord;
  claimIds: readonly string[];
  claims: readonly Claim[];
  onLink: (claimId: string) => void;
  onRestored: () => void;
}): ReactElement {
  const [source, setSource] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Rerendering | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [claimId, setClaimId] = useState('');
  // Bumped after a re-render, so a preview that had nothing to show looks again.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const signal = { cancelled: false };
    readBlob(client, artifact.artifactId, artifact.sourceHash)
      .then((bytes) => {
        if (!signal.cancelled) setSource(new TextDecoder().decode(bytes));
      })
      .catch(() => {
        // The facts below still name the source by hash.
      });
    return () => {
      signal.cancelled = true;
    };
  }, [client, artifact.artifactId, artifact.sourceHash]);

  const rerender = async (): Promise<void> => {
    setChecking(true);
    setProblem(null);
    try {
      const reply = await client.invoke('sheep:artifact-rerender', {
        artifactId: artifact.artifactId,
      });
      setResult(reply);
      setGeneration((value) => value + 1);
      if (reply.files.some((file) => file.restored)) onRestored();
    } catch (error) {
      setResult(null);
      setProblem(describe(error));
    } finally {
      setChecking(false);
    }
  };

  const linkable = claims.filter((claim) => !claimIds.includes(claim.claimId));
  // What the screen shows: a vector image when there is one, the PDF when not.
  const preview =
    artifact.outputs.find((output) => extensionOf(output.path) === 'svg') ??
    artifact.outputs.find((output) => extensionOf(output.path) === 'png') ??
    artifact.outputs[0];

  return (
    <div className="lab__run" data-sheep-artifact-detail={artifact.artifactId}>
      <div className="lab__run-head">
        <span className="badge">{KINDS[artifact.kind].label}</span>
        <strong>{artifact.title}</strong>
      </div>

      {preview && (
        <Preview
          key={`${preview.hash}-${String(generation)}`}
          client={client}
          artifactId={artifact.artifactId}
          hash={preview.hash}
          path={preview.path}
          label={artifact.title}
        />
      )}

      <dl className="drawer__facts">
        <dt>Artifact</dt>
        <dd>
          <code className="drawer__mono">{artifact.artifactId}</code>
        </dd>
        <dt>Rendered by</dt>
        <dd>{artifact.toolchain}</dd>
        {artifact.executionId !== null && (
          <>
            <dt>Drawn by run</dt>
            <dd>
              <code className="drawer__mono">{artifact.executionId}</code>
            </dd>
          </>
        )}
        <dt>Source</dt>
        <dd>
          <code title={artifact.sourceHash}>{artifact.sourceHash.slice(0, 12)}</code>
        </dd>
        <dt>Files</dt>
        <dd>
          {artifact.outputs.map((output) => (
            <div key={output.path}>
              {output.path} <span className="lab__muted">{formatBytes(output.bytes)}</span>{' '}
              <code className="lab__muted" title={output.hash}>
                {output.hash.slice(0, 12)}
              </code>
            </div>
          ))}
        </dd>
        <dt>Claims</dt>
        <dd data-sheep-artifact-claims={String(claimIds.length)}>
          {claimIds.length > 0
            ? claimIds.map((id) => (
                <div key={id}>
                  <code>{id.slice(0, 8)}</code>{' '}
                  {claims.find((claim) => claim.claimId === id)?.statement ?? ''}
                </div>
              ))
            : 'none yet'}
        </dd>
      </dl>

      {linkable.length > 0 && (
        <div className="button-row">
          <select
            className="field__input artifacts__claim"
            aria-label="Claim this figure supports"
            value={claimId}
            onChange={(event) => {
              setClaimId(event.target.value);
            }}
          >
            <option value="">Attach to a claim…</option>
            {linkable.map((claim) => (
              <option key={claim.claimId} value={claim.claimId}>
                {claim.claimType} · {claim.statement.slice(0, 80)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button button--quiet"
            disabled={claimId === ''}
            onClick={() => {
              onLink(claimId);
              setClaimId('');
            }}
          >
            Attach as evidence
          </button>
        </div>
      )}

      <div className="button-row">
        <button
          type="button"
          className="button button--quiet"
          data-sheep-artifact-rerender
          disabled={checking}
          onClick={() => {
            void rerender();
          }}
        >
          {checking ? 'Rendering again…' : 'Re-render from source and compare'}
        </button>
      </div>

      {problem !== null && (
        <pre className="notice notice--error artifacts__problem" role="alert">
          {problem}
        </pre>
      )}

      {result && (
        <div
          className={result.identical ? 'notice' : 'notice notice--error'}
          data-sheep-artifact-identical={String(result.identical)}
        >
          <strong>
            {result.identical
              ? 'Byte-identical: the source still renders to exactly what was recorded.'
              : 'Different: the source no longer renders to what was recorded.'}
          </strong>
          {!result.identical && (
            <p className="verify__reason">
              Recorded with {result.toolchain.recorded}; rendered now with{' '}
              {result.toolchain.current}. The recorded files were kept; nothing was replaced.
            </p>
          )}
          <ul className="artifacts__files">
            {result.files.map((file) => (
              <li key={file.path}>
                {file.path} —{' '}
                {file.regenerated === null
                  ? 'not produced this time'
                  : file.regenerated === file.recorded
                    ? `same bytes (${file.recorded.slice(0, 12)})`
                    : `recorded ${file.recorded.slice(0, 12)}, now ${file.regenerated.slice(0, 12)}`}
                {file.restored && ' · was missing from the store, put back'}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3 className="calibration__title">Source</h3>
      <pre className="lab__output" data-sheep-artifact-source-shown>
        {source ?? '…'}
      </pre>
    </div>
  );
}

/** One rendering, shown: an image as an image, a PDF drawn page-first. */
function Preview({
  client,
  artifactId,
  hash,
  path,
  label,
}: {
  client: IpcClient;
  artifactId: string;
  hash: string;
  path: string;
  label: string;
}): ReactElement | null {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const signal = { cancelled: false };
    readBlob(client, artifactId, hash)
      .then((data) => {
        if (!signal.cancelled) setBytes(data);
      })
      .catch(() => {
        if (!signal.cancelled) setMissing(true);
      });
    return () => {
      signal.cancelled = true;
    };
  }, [client, artifactId, hash]);

  if (missing) {
    return (
      <p className="notice">
        This rendering is not in the store. Re-render from source to put it back.
      </p>
    );
  }
  if (!bytes) return null;

  const extension = extensionOf(path);
  if (extension === 'pdf') return <PdfPreview data={bytes} label={label} />;
  const mediaType = extension === 'svg' ? 'image/svg+xml' : 'image/png';
  // An <img> does not run scripts, so an SVG a model's source produced is inert here.
  return (
    <img
      className="lab__plot"
      src={`data:${mediaType};base64,${toBase64(bytes)}`}
      alt={label}
      data-sheep-artifact-image
    />
  );
}

async function readBlob(client: IpcClient, artifactId: string, hash: string): Promise<Uint8Array> {
  const blob = await client.invoke('sheep:artifact-blob', { artifactId, hash });
  return Uint8Array.from(atob(blob.base64), (char) => char.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function extensionOf(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1).toLowerCase();
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // The reason is the useful part; the IPC wrapping is not.
  return message.replace(/^.*IPC_HANDLER_FAILED: [^ ]+ /, '');
}

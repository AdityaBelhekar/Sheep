import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { IpcClient, IpcResponse } from '@sheep/ipc';
import { paneById } from '@shared/panes';
import { PdfPreview } from '../components/PdfPreview';

type Templates = IpcResponse<'sheep:paper-templates'>;
type Compiled = IpcResponse<'sheep:paper-compile'>;
type Exported = Extract<IpcResponse<'sheep:paper-export'>, { ok: true }>;
type TemplateId = string;

/** Which template was last chosen, kept across navigation. */
const draft: { template: TemplateId; omit: boolean } = { template: 'sheep', omit: false };

/**
 * The session, compiled into a paper.
 *
 * Nothing is written here and nothing can be: the paper is built from the
 * ledger and the log each time it is compiled, in whichever template is
 * chosen. What can differ between two templates is the page, never the text.
 *
 * A sentence that asserts something and names no claim in the ledger stops the
 * build, and the pane shows the sentence. The only other choice offered is to
 * leave it out, which the paper then says it did.
 */
export function PaperPane({ client }: { client: IpcClient | undefined }): ReactElement {
  const pane = paneById('paper');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Templates | null>(null);
  const [template, setTemplate] = useState<TemplateId>(draft.template);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Compiled | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [omit, setOmit] = useState(draft.omit);
  const [exported, setExported] = useState<Exported | null>(null);

  draft.template = template;
  draft.omit = omit;

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
      .invoke('sheep:paper-templates', {})
      .then((reply) => {
        if (!signal.cancelled) setTemplates(reply);
      })
      .catch((error: unknown) => {
        if (!signal.cancelled) setProblem(describe(error));
      });
    return () => {
      signal.cancelled = true;
    };
  }, [client]);

  const compile = async (): Promise<void> => {
    if (!client || sessionId === null || busy) return;
    setProblem(null);
    setBusy(true);
    setExported(null);
    try {
      setResult(
        await client.invoke('sheep:paper-compile', {
          sessionId,
          template,
          omitUnprovenanced: omit,
        }),
      );
    } catch (error) {
      setResult(null);
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const exportBundle = async (): Promise<void> => {
    if (!client || sessionId === null || busy) return;
    setProblem(null);
    setBusy(true);
    try {
      const reply = await client.invoke('sheep:paper-export', {
        sessionId,
        template,
        omitUnprovenanced: omit,
      });
      // A refusal to export is the same refusal as to compile, and is shown the same way.
      if (reply.ok) setExported(reply);
      else setResult(reply);
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const pdf = useMemo(
    () =>
      result?.ok ? Uint8Array.from(atob(result.pdf), (char) => char.charCodeAt(0)) : undefined,
    [result],
  );
  const chosen = templates?.templates.find((entry) => entry.id === template);

  return (
    <section
      className="pane pane--wide"
      data-pane="paper"
      data-sheep-paper={result ? (result.ok ? 'compiled' : 'refused') : undefined}
    >
      <header className="pane__header">
        <h1 className="pane__title">{pane.label}</h1>
        <p className="pane__summary">{pane.summary}</p>
      </header>

      {!client && <p className="notice notice--error">The paper needs the preload bridge.</p>}

      {client && templates?.available === false && (
        <p className="notice notice--error" role="alert">
          {templates.detail}
        </p>
      )}

      {client && sessionId === null && (
        <div className="empty">
          <p className="empty__title">No session is open</p>
          <p className="empty__body">Open a session first.</p>
        </div>
      )}

      {client && sessionId !== null && templates && (
        <div className="paper">
          <div className="button-row" role="tablist" aria-label="Template">
            {templates.templates.map((option) => (
              <button
                key={option.id}
                type="button"
                role="tab"
                className="button button--quiet"
                aria-selected={option.id === template}
                data-sheep-paper-template={option.id}
                onClick={() => {
                  setTemplate(option.id);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          {chosen && <p className="lab__muted">{chosen.description}</p>}

          <div className="button-row">
            <button
              type="button"
              className="button"
              data-sheep-paper-compile
              disabled={busy || !templates.available}
              onClick={() => {
                void compile();
              }}
            >
              {busy ? 'Compiling…' : 'Compile'}
            </button>
            <button
              type="button"
              className="button button--quiet"
              data-sheep-paper-export
              disabled={busy || !templates.available}
              onClick={() => {
                void exportBundle();
              }}
            >
              Export reproduction bundle
            </button>
            {templates.available && <span className="lab__muted">{templates.detail}</span>}
          </div>
          <label className="verify__toggle">
            <input
              type="checkbox"
              data-sheep-paper-omit
              checked={omit}
              onChange={(event) => {
                setOmit(event.target.checked);
              }}
            />
            Leave out sentences that name no claim in the ledger, instead of refusing to build
          </label>

          {exported && (
            <p className="notice" data-sheep-paper-exported={String(exported.saved)}>
              {exported.saved
                ? `Saved ${String(exported.files)} files (${formatBytes(exported.bytes)}) to ${exported.path ?? ''}. Run reproduce.py from the unpacked bundle to redraw every figure and compare.`
                : 'Nothing was saved.'}
            </p>
          )}

          {problem !== null && (
            <p className="notice notice--error" role="alert">
              {problem}
            </p>
          )}

          {result && !result.ok && (
            <div className="notice notice--error" role="alert">
              <strong>The paper was not compiled.</strong>
              {result.unprovenanced.length > 0 && (
                <>
                  <p className="verify__reason">
                    {result.unprovenanced.length === 1
                      ? 'This sentence asserts'
                      : 'These sentences assert'}{' '}
                    something with no claim in the ledger behind{' '}
                    {result.unprovenanced.length === 1 ? 'it' : 'them'}. A paper cannot say what its
                    ledger does not hold.
                  </p>
                  <ul className="artifacts__files">
                    {result.unprovenanced.map((entry, index) => (
                      <li key={index} data-sheep-paper-unprovenanced>
                        <em>{entry.section}:</em> &ldquo;{entry.text}&rdquo; — {entry.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <ul className="artifacts__files">
                {result.problems.map((entry, index) => (
                  <li key={index} data-sheep-paper-problem>
                    {entry.file !== null && (
                      <code>
                        {entry.file}
                        {entry.line !== null && `:${String(entry.line)}`}{' '}
                      </code>
                    )}
                    {entry.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result?.ok && pdf && (
            <>
              <p className="lab__muted" data-sheep-paper-summary>
                {result.claims} claim{result.claims === 1 ? '' : 's'} · {result.figures} figure
                {result.figures === 1 ? '' : 's'} · {formatBytes(result.bytes)}
                {result.warnings.length > 0 &&
                  ` · ${String(result.warnings.length)} remark${
                    result.warnings.length === 1 ? '' : 's'
                  } from the engine`}
                {result.omitted.length > 0 &&
                  ` · ${String(result.omitted.length)} unprovenanced sentence${
                    result.omitted.length === 1 ? '' : 's'
                  } left out`}
              </p>
              {result.warnings.length > 0 && (
                <details className="lab__muted">
                  <summary>What the engine remarked on</summary>
                  <ul className="artifacts__files">
                    {result.warnings.map((entry, index) => (
                      <li key={index}>
                        {entry.file !== null &&
                          `${entry.file}${entry.line === null ? '' : `:${String(entry.line)}`} `}
                        {entry.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <PdfPreview data={pdf} label="The compiled paper" allPages />
            </>
          )}
        </div>
      )}
    </section>
  );
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

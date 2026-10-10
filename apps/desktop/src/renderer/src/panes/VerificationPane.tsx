import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  derivationSchema,
  type Derivation,
  type DerivationStep,
  type DimensionVerdict,
} from '@sheep/core';
import type { IpcClient, IpcResponse } from '@sheep/ipc';
import { paneById } from '@shared/panes';
import { Formula } from '../components/Formula';

type Detail = IpcResponse<'sheep:derivation-check'>;
type History = IpcResponse<'sheep:derivations-list'>;

const STARTER: Derivation = {
  title: 'Kinetic energy from the work done by a constant force',
  symbols: {
    W: { units: 'joule' },
    F: { units: 'newton' },
    d: { units: 'm' },
    m: { units: 'kg' },
    a: { units: 'm/s**2' },
    v: { units: 'm/s' },
  },
  given: [
    { id: 'g1', statement: 'W = F*d' },
    { id: 'g2', statement: 'F = m*a' },
    { id: 'g3', statement: 'v**2 = 2*a*d' },
  ],
  steps: [
    { id: 's1', statement: 'W = m*a*d', operation: 'substitute', from: 'g1', using: 'g2' },
    { id: 's2', statement: 'a*d = v**2/2', operation: 'divide', from: 'g3', args: { value: '2' } },
    { id: 's3', statement: 'W = m*v**2/2', operation: 'substitute', from: 's1', using: 's2' },
  ],
};

/** What was being written, kept across navigation, as the Lab keeps its script. */
const draft = { text: JSON.stringify(STARTER, null, 2) };

/**
 * Derivations, checked step by step.
 *
 * Every step is shown with the verdict a program gave it. A step no checker
 * could decide is listed with the rest, marked UNCHECKABLE and saying why —
 * it is never left out and never shown as if it had passed. The whole
 * derivation is a pass only when every step is.
 */
export function VerificationPane({
  client,
  onStoreChanged,
}: {
  client: IpcClient | undefined;
  onStoreChanged: () => void;
}): ReactElement {
  const pane = paneById('verification');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [text, setText] = useState(draft.text);
  const [history, setHistory] = useState<History | null>(null);
  const [shown, setShown] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [showLatex, setShowLatex] = useState(false);

  draft.text = text;

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
    return () => {
      signal.cancelled = true;
    };
  }, [client]);

  const loadHistory = useCallback(async () => {
    if (!client || sessionId === null) return;
    try {
      setHistory(await client.invoke('sheep:derivations-list', { sessionId }));
    } catch (error) {
      setProblem(describe(error));
    }
  }, [client, sessionId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const check = async (): Promise<void> => {
    if (!client || sessionId === null || busy) return;
    setProblem(null);

    let derivation: Derivation;
    try {
      const parsed = derivationSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        const [issue] = parsed.error.issues;
        setProblem(`not a derivation: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`);
        return;
      }
      derivation = parsed.data;
    } catch (error) {
      setProblem(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    setBusy(true);
    try {
      setShown(await client.invoke('sheep:derivation-check', { sessionId, derivation }));
      await loadHistory();
      onStoreChanged();
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const open = (derivationId: string): void => {
    if (!client) return;
    client
      .invoke('sheep:derivation-get', { derivationId })
      .then(setShown)
      .catch((error: unknown) => {
        setProblem(describe(error));
      });
  };

  const claimsOn = (derivationId: string): readonly string[] =>
    history?.backing.find((entry) => entry.derivationId === derivationId)?.claimIds ?? [];

  return (
    <section
      className="pane pane--wide"
      data-pane="verification"
      data-sheep-derivations={history ? String(history.derivations.length) : undefined}
    >
      <header className="pane__header">
        <h1 className="pane__title">{pane.label}</h1>
        <p className="pane__summary">{pane.summary}</p>
      </header>

      {!client && <p className="notice notice--error">Verification needs the preload bridge.</p>}

      {client && sessionId === null && (
        <div className="empty">
          <p className="empty__title">No session is open</p>
          <p className="empty__body">
            Open a session from Sessions. A checked derivation belongs to a session, so a DERIVED
            claim made in it has something to point at.
          </p>
        </div>
      )}

      {client && sessionId !== null && (
        <div className="verify">
          <div className="verify__compose">
            <label className="field">
              <span className="field__label">
                Derivation — premises, then steps that each declare their operation
              </span>
              <textarea
                className="field__input field__input--multiline verify__source"
                spellCheck={false}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                }}
              />
            </label>
            <div className="button-row">
              <button
                type="button"
                className="button"
                data-sheep-verify-check
                disabled={busy}
                onClick={() => {
                  void check();
                }}
              >
                {busy ? 'Checking…' : 'Check'}
              </button>
              <label className="verify__toggle">
                <input
                  type="checkbox"
                  checked={showLatex}
                  onChange={(event) => {
                    setShowLatex(event.target.checked);
                  }}
                />
                Show LaTeX
              </label>
            </div>
            <p className="lab__muted">
              Operations with a checker: rewrite, substitute, add, subtract, multiply, divide,
              power, apply, differentiate, integrate, add-equations, subtract-equations, solve.
              Anything else is recorded and reported as UNCHECKABLE.
            </p>
            {problem !== null && (
              <p className="notice notice--error" role="alert">
                {problem}
              </p>
            )}
          </div>

          <div className="verify__result">
            {shown ? (
              <Verdict
                detail={shown}
                claimIds={claimsOn(shown.record.derivationId)}
                showLatex={showLatex}
              />
            ) : (
              <div className="empty">
                <p className="empty__title">Nothing checked yet</p>
                <p className="empty__body">
                  Check the derivation, or open an earlier one below. Each step is shown with the
                  verdict SymPy gave it.
                </p>
              </div>
            )}
          </div>

          {history && history.derivations.length > 0 && (
            <div className="lab__history">
              <h2 className="calibration__title">Derivations in this session</h2>
              <ul className="lab__runs">
                {history.derivations.map((record) => (
                  <li key={record.derivationId}>
                    <button
                      type="button"
                      className="lab__run-row"
                      data-sheep-derivation={record.derivationId}
                      aria-current={
                        record.derivationId === shown?.record.derivationId ? 'true' : undefined
                      }
                      onClick={() => {
                        open(record.derivationId);
                      }}
                    >
                      <span className="badge" data-status={record.status}>
                        {record.status}
                      </span>
                      <span>{record.title ?? 'Untitled derivation'}</span>
                      <span className="lab__muted">{countsOf(record.counts)}</span>
                      {claimsOn(record.derivationId).length > 0 && (
                        <span className="lab__muted">
                          backs {claimsOn(record.derivationId).length} claim
                          {claimsOn(record.derivationId).length === 1 ? '' : 's'}
                        </span>
                      )}
                      <code className="lab__muted">{record.derivationId.slice(0, 8)}</code>
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

function Verdict({
  detail,
  claimIds,
  showLatex,
}: {
  detail: Detail;
  claimIds: readonly string[];
  showLatex: boolean;
}): ReactElement {
  const { record, derivation, verdict } = detail;
  const stepOf = new Map(derivation.steps.map((step) => [step.id, step]));
  const givenOf = new Map(derivation.given.map((given) => [given.id, given]));

  return (
    <div className="lab__run" data-sheep-verdict={verdict.status}>
      <div className="lab__run-head">
        <span className="badge" data-status={verdict.status}>
          {verdict.status}
        </span>
        <strong>{record.title ?? 'Untitled derivation'}</strong>
        <span className="lab__muted">{countsOf(verdict.counts)}</span>
      </div>

      <dl className="drawer__facts">
        <dt>Derivation</dt>
        <dd>
          <code className="drawer__mono">{record.derivationId}</code>
        </dd>
        <dt>Checked by</dt>
        <dd>
          SymPy, in the sandbox · env <code>{record.envLockHash.slice(0, 12)}</code>
        </dd>
        <dt>Claims</dt>
        <dd>
          {claimIds.length > 0
            ? claimIds.map((claimId) => claimId.slice(0, 8)).join(', ')
            : verdict.status === 'FAIL'
              ? 'none — a derivation with a step that fails cannot back a claim'
              : 'none yet — cite the derivation id as DERIVATION evidence in the Ledger'}
        </dd>
      </dl>

      {verdict.counts.uncheckable > 0 && (
        <p className="notice verify__caution">
          {verdict.counts.uncheckable} step{verdict.counts.uncheckable === 1 ? ' was' : 's were'}{' '}
          not verified. {verdict.counts.uncheckable === 1 ? 'It is' : 'They are'} marked below, and{' '}
          {verdict.counts.uncheckable === 1 ? 'is' : 'are'} not assumed to be correct.
        </p>
      )}

      <table className="verify__table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Statement</th>
            <th scope="col">Follows by</th>
            <th scope="col">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {verdict.given.map((given) => (
            <tr key={given.id} data-sheep-given={given.id}>
              <th scope="row">{given.id}</th>
              <td>
                <Formula
                  latex={given.latex}
                  source={givenOf.get(given.id)?.statement ?? ''}
                  showLatex={showLatex}
                />
              </td>
              <td className="lab__muted">premise</td>
              <td>
                <span className="badge">given</span>
                {given.problem !== null && <p className="verify__reason">{given.problem}</p>}
                <Dimensions verdict={given.dimensions} />
              </td>
            </tr>
          ))}
          {verdict.steps.map((step) => {
            const written = stepOf.get(step.id);
            return (
              <tr key={step.id} data-sheep-step={step.id} data-status={step.status}>
                <th scope="row">{step.id}</th>
                <td>
                  <Formula
                    latex={step.latex}
                    source={written?.statement ?? ''}
                    showLatex={showLatex}
                  />
                </td>
                <td className="lab__muted">{written ? operationOf(written) : ''}</td>
                <td>
                  <span className="badge" data-status={step.status}>
                    {step.status}
                  </span>
                  <p className="verify__reason">{step.reason}</p>
                  <Dimensions verdict={step.dimensions} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Dimensions({ verdict }: { verdict: DimensionVerdict | null }): ReactElement | null {
  if (verdict === null) return null;
  return (
    <p className="verify__reason" data-dimensions={verdict.status}>
      <span className="badge" data-status={verdict.status}>
        units {verdict.status}
      </span>{' '}
      {verdict.reason}
    </p>
  );
}

/** "substitute from g1 using g2 (value = 2)". */
function operationOf(step: DerivationStep): string {
  const args = Object.entries(step.args ?? {})
    .map(([name, value]) => `${name} = ${value}`)
    .join(', ');
  return [
    step.operation,
    step.from === undefined ? '' : `from ${step.from}`,
    step.using === undefined ? '' : `using ${step.using}`,
    args === '' ? '' : `(${args})`,
  ]
    .filter(Boolean)
    .join(' ');
}

function countsOf(counts: { pass: number; fail: number; uncheckable: number }): string {
  return `${String(counts.pass)} pass · ${String(counts.fail)} fail · ${String(counts.uncheckable)} uncheckable`;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // The reason is the useful part; the IPC wrapping is not.
  return message.replace(/^.*IPC_HANDLER_FAILED: [^ ]+ /, '');
}

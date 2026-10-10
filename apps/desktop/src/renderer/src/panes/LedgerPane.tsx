import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { CLAIM_TYPES, EVIDENCE_KINDS, type ClaimType, type EvidenceKind } from '@sheep/core';
import type { IpcClient, IpcResponse } from '@sheep/ipc';
import { paneById } from '@shared/panes';
import {
  evidenceNodeId,
  layoutClaimGraph,
  lineageOf,
  NODE_HEIGHT,
  NODE_WIDTH,
  type ClaimGraph,
  type GraphNode,
} from './claimGraph';
import { LiteraturePanel } from './LiteraturePanel';

type Ledger = IpcResponse<'sheep:ledger-get'>;

type Loaded =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; ledger: Ledger }
  | { kind: 'error'; message: string };

/**
 * The claim ledger: what has been claimed, what backs it, and what attacks it.
 *
 * Everything drawn here was derived in main from the event log — statuses,
 * calibration, movement. This pane decides nothing; it lays the ledger out so
 * a person can follow any claim back to what it rests on.
 */
export function LedgerPane({
  client,
  onStoreChanged,
}: {
  client: IpcClient | undefined;
  onStoreChanged: () => void;
}): ReactElement {
  const pane = paneById('ledger');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<Loaded>({ kind: 'idle' });
  const [selected, setSelected] = useState<string | null>(null);

  // The open session is the shell's, written by the roster panel.
  useEffect(() => {
    if (!client) return;
    const signal = { cancelled: false };
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

  const load = useCallback(async () => {
    if (!client || sessionId === null) return;
    try {
      setState({ kind: 'ready', ledger: await client.invoke('sheep:ledger-get', { sessionId }) });
    } catch (error) {
      setState({ kind: 'error', message: describe(error) });
    }
  }, [client, sessionId]);

  useEffect(() => {
    if (sessionId === null) return;
    setState({ kind: 'loading' });
    void load();
  }, [load, sessionId]);

  const ledger = state.kind === 'ready' ? state.ledger : null;
  const graph = useMemo(
    () => (ledger ? layoutClaimGraph(ledger.claims, ledger.disputes) : null),
    [ledger],
  );

  return (
    <section
      className="pane pane--wide"
      data-pane="ledger"
      data-sheep-claims={ledger ? String(ledger.claims.length) : undefined}
    >
      <header className="pane__header">
        <h1 className="pane__title">{pane.label}</h1>
        <p className="pane__summary">{pane.summary}</p>
      </header>

      {!client && <p className="notice notice--error">The ledger needs the preload bridge.</p>}

      {client && sessionId === null && (
        <div className="empty">
          <p className="empty__title">No session is open</p>
          <p className="empty__body">Open a session first.</p>
        </div>
      )}

      {state.kind === 'loading' && <p className="notice">Replaying the ledger…</p>}
      {state.kind === 'error' && (
        <p className="notice notice--error" role="alert">
          {state.message}
        </p>
      )}

      {ledger && graph && sessionId !== null && client && (
        <>
          {ledger.rejected > 0 && (
            <p className="notice notice--error" role="alert">
              {ledger.rejected} log entr{ledger.rejected === 1 ? 'y breaks' : 'ies break'} a ledger
              rule and {ledger.rejected === 1 ? 'is' : 'are'} left out of this view.
            </p>
          )}

          {ledger.claims.length === 0 ? (
            <div className="empty">
              <p className="empty__title">No claims yet</p>
              <p className="empty__body">
                Hypotheses selected at the HYPOTHESIS gate become conjectures here. You can also
                record a claim below — it is held to the same rules as a model’s.
              </p>
            </div>
          ) : (
            <div className="ledger__main">
              <GraphView graph={graph} selected={selected} onSelect={setSelected} />
              {selected !== null && (
                <ProvenanceDrawer
                  client={client}
                  sessionId={sessionId}
                  ledger={ledger}
                  nodeId={selected}
                  onSelect={setSelected}
                />
              )}
            </div>
          )}

          <Legend />

          <CalibrationTable ledger={ledger} />

          <RecordClaim
            client={client}
            sessionId={sessionId}
            onRecorded={(reply) => {
              setState({ kind: 'ready', ledger: reply });
              setSelected(reply.claimId);
              onStoreChanged();
            }}
          />

          <LiteraturePanel
            client={client}
            sessionId={sessionId}
            onLedgerChanged={() => {
              void load();
              onStoreChanged();
            }}
          />
        </>
      )}
    </section>
  );
}

function GraphView({
  graph,
  selected,
  onSelect,
}: {
  graph: ClaimGraph;
  selected: string | null;
  onSelect: (id: string | null) => void;
}): ReactElement {
  const lineage = useMemo(
    () => (selected === null ? null : lineageOf(graph, selected)),
    [graph, selected],
  );
  const at = new Map(graph.nodes.map((node) => [node.id, node]));

  return (
    <div
      className="graph"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onSelect(null);
      }}
    >
      <svg
        className="graph__canvas"
        width={graph.width}
        height={graph.height}
        viewBox={`0 0 ${String(graph.width)} ${String(graph.height)}`}
        role="group"
        aria-label="Claim graph"
        onClick={(event) => {
          if (event.target === event.currentTarget) onSelect(null);
        }}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 8 8"
            refX="8"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8 z" className="graph__arrow" />
          </marker>
        </defs>

        {graph.edges.map((edge) => {
          const from = at.get(edge.from);
          const to = at.get(edge.to);
          if (!from || !to) return null;
          const x1 = from.x + NODE_WIDTH;
          const y1 = from.y + NODE_HEIGHT / 2;
          const x2 = to.x;
          const y2 = to.y + NODE_HEIGHT / 2;
          // Disputes sit to the right of what they attack, so their edge runs back.
          const back = x2 < x1;
          const sx = back ? from.x : x1;
          const tx = back ? to.x + NODE_WIDTH : x2;
          const bend = Math.max(24, Math.abs(tx - sx) / 2);
          const dim = lineage !== null && !(lineage.has(edge.from) && lineage.has(edge.to));
          return (
            <path
              key={`${edge.from}->${edge.to}`}
              className="graph__edge"
              data-kind={edge.kind}
              data-dim={dim ? 'true' : undefined}
              d={`M${String(sx)},${String(y1)} C${String(sx + (back ? -bend : bend))},${String(y1)} ${String(tx + (back ? bend : -bend))},${String(y2)} ${String(tx)},${String(y2)}`}
              markerEnd="url(#arrow)"
            />
          );
        })}

        {graph.nodes.map((node) => (
          <Node
            key={node.id}
            node={node}
            selected={node.id === selected}
            dim={lineage !== null && !lineage.has(node.id)}
            onSelect={onSelect}
          />
        ))}
      </svg>
    </div>
  );
}

function Node({
  node,
  selected,
  dim,
  onSelect,
}: {
  node: GraphNode;
  selected: boolean;
  dim: boolean;
  onSelect: (id: string) => void;
}): ReactElement {
  const kicker =
    node.kind === 'claim'
      ? node.status
      : node.kind === 'dispute'
        ? `dispute · ${node.status}`
        : node.status;
  return (
    <g
      className="graph__node"
      data-kind={node.kind}
      data-status={node.status}
      data-selected={selected ? 'true' : undefined}
      data-dim={dim ? 'true' : undefined}
      data-sheep-node={node.id}
      transform={`translate(${String(node.x)},${String(node.y)})`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${kicker}: ${node.label}`}
      onClick={() => {
        onSelect(node.id);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(node.id);
        }
      }}
    >
      <title>{node.label}</title>
      <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={6} className="graph__box" />
      <foreignObject x={0} y={0} width={NODE_WIDTH} height={NODE_HEIGHT}>
        <div className="graph__text">
          <span className="graph__kicker">{kicker}</span>
          <span className="graph__label">{node.label}</span>
        </div>
      </foreignObject>
    </g>
  );
}

type Provenance = IpcResponse<'sheep:claim-provenance'>;

/**
 * One click from any node to where it came from.
 *
 * For a claim: the model and version that asserted it, what it was sent with,
 * the prompt hash that reproduces the call, what it cost and when, and every
 * claim beneath it with the disputes raised along the way. A claim a person
 * wrote says so rather than showing empty model fields.
 */
function ProvenanceDrawer({
  client,
  sessionId,
  ledger,
  nodeId,
  onSelect,
}: {
  client: IpcClient;
  sessionId: string;
  ledger: Ledger;
  nodeId: string;
  onSelect: (id: string | null) => void;
}): ReactElement {
  const claim = ledger.claims.find((candidate) => candidate.claimId === nodeId);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!claim) return;
    const signal = { cancelled: false };
    setProvenance(null);
    setProblem(null);
    client
      .invoke('sheep:claim-provenance', { sessionId, claimId: claim.claimId })
      .then((reply) => {
        if (!signal.cancelled) setProvenance(reply);
      })
      .catch((error: unknown) => {
        if (!signal.cancelled) setProblem(describe(error));
      });
    return () => {
      signal.cancelled = true;
    };
  }, [client, sessionId, claim]);

  const close = (
    <button
      type="button"
      className="button button--quiet drawer__close"
      aria-label="Close provenance"
      onClick={() => {
        onSelect(null);
      }}
    >
      ×
    </button>
  );

  if (!claim) {
    const dispute = ledger.disputes.find((candidate) => candidate.disputeId === nodeId);
    if (dispute) {
      const resolution = ledger.resolutions.find((r) => r.disputeId === dispute.disputeId);
      return (
        <aside className="drawer" aria-label="Dispute">
          <header className="drawer__head">
            <span className="badge" data-status={dispute.status}>
              dispute · {dispute.status}
            </span>
            {close}
          </header>
          <p className="drawer__statement">{dispute.argument}</p>
          <dl className="drawer__facts">
            <Fact term="Axis" value={`${dispute.axis} · ${dispute.severity}`} />
            <Fact term="Raised by" value={participantName(ledger, dispute.raisedByParticipantId)} />
            <Fact term="Opened" value={dispute.openedAt} />
            {dispute.proposedTest && (
              <Fact
                term="Proposed test"
                value={`${dispute.proposedTest.route}: ${dispute.proposedTest.description}`}
              />
            )}
            {resolution && (
              <Fact term="Outcome" value={`${resolution.outcome} — ${resolution.rationale}`} />
            )}
          </dl>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              onSelect(dispute.claimId);
            }}
          >
            Open the disputed claim
          </button>
        </aside>
      );
    }
    const resting = ledger.claims.filter((c) =>
      c.support.some((evidence) => evidenceNodeId(evidence) === nodeId),
    );
    return (
      <aside className="drawer" aria-label="Evidence">
        <header className="drawer__head">
          <span className="badge">evidence</span>
          {close}
        </header>
        <p className="drawer__statement drawer__mono">{nodeId}</p>
        <p className="drawer__section">Supports</p>
        <ClaimList claims={resting.map((c) => ({ claim: c, depth: 1 }))} onSelect={onSelect} />
      </aside>
    );
  }

  const message = provenance?.message ?? null;
  const author = provenance?.author ?? null;
  const model = message?.author.kind === 'MODEL' ? message.author.model : (author?.model ?? null);

  return (
    <aside className="drawer" aria-label="Claim provenance" data-sheep-provenance={claim.claimId}>
      <header className="drawer__head">
        <span className="badge">{claim.claimType}</span>
        <span className="badge" data-status={claim.status}>
          {claim.status}
        </span>
        {close}
      </header>
      <p className="drawer__statement">{claim.statement}</p>

      {problem !== null && (
        <p className="notice notice--error" role="alert">
          {problem}
        </p>
      )}
      {provenance === null && problem === null && <p className="notice">Tracing…</p>}

      {provenance && (
        <>
          <dl className="drawer__facts">
            {claim.authorParticipantId === null ? (
              <Fact term="Author" value="Recorded by a person — no model produced this claim" />
            ) : (
              <>
                <Fact
                  term="Model"
                  value={model ? `${model.vendorId} · ${model.modelId}` : 'unknown participant'}
                />
                <Fact term="Version" value={model?.version ?? 'not reported by the provider'} />
                <Fact term="Role" value={message?.role ?? '—'} />
                <Fact
                  term="Params"
                  value={
                    message?.params
                      ? `max ${String(message.params.maxOutputTokens)} output tokens · temperature ${
                          message.params.temperature === undefined
                            ? 'provider default'
                            : String(message.params.temperature)
                        }`
                      : 'not recorded'
                  }
                />
                <Fact term="Prompt hash" value={message?.promptHash ?? 'not recorded'} mono />
                <Fact
                  term="Cost"
                  value={
                    message?.usage
                      ? `$${message.usage.costUsd.toFixed(4)} · ${String(message.usage.inputTokens)} in / ${String(message.usage.outputTokens)} out`
                      : 'not priced'
                  }
                />
                <Fact term="Asserted" value={message?.recordedAt ?? '—'} />
              </>
            )}
            <Fact term="Recorded" value={claim.recordedAt} />
            <Fact term="Claim id" value={claim.claimId} mono />
          </dl>

          <p className="drawer__section">Support</p>
          {claim.support.length === 0 ? (
            <p className="drawer__empty">Nothing — honestly unbacked.</p>
          ) : (
            <ul className="drawer__list">
              {claim.support.map((evidence) => (
                <li key={`${evidence.kind}:${evidence.ref}`}>
                  <span className="badge">{evidence.kind}</span>{' '}
                  <span className="drawer__mono">{evidence.ref}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="drawer__section">Ancestry</p>
          {provenance.ancestry.length === 0 ? (
            <p className="drawer__empty">Rests on no other claim.</p>
          ) : (
            <ClaimList claims={provenance.ancestry} onSelect={onSelect} />
          )}

          {provenance.disputes.length > 0 && (
            <>
              <p className="drawer__section">Disputes along the lineage</p>
              <ul className="drawer__list">
                {provenance.disputes.map((dispute) => (
                  <li key={dispute.disputeId}>
                    <button
                      type="button"
                      className="drawer__link"
                      onClick={() => {
                        onSelect(dispute.disputeId);
                      }}
                    >
                      <span className="badge" data-status={dispute.status}>
                        {dispute.status}
                      </span>{' '}
                      {dispute.axis}: {dispute.argument}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </aside>
  );
}

function ClaimList({
  claims,
  onSelect,
}: {
  claims: readonly { claim: Ledger['claims'][number]; depth: number }[];
  onSelect: (id: string) => void;
}): ReactElement {
  return (
    <ul className="drawer__list" data-sheep-ancestry={claims.length}>
      {claims.map(({ claim, depth }) => (
        <li key={claim.claimId} style={{ paddingLeft: `${String((depth - 1) * 0.9)}rem` }}>
          <button
            type="button"
            className="drawer__link"
            onClick={() => {
              onSelect(claim.claimId);
            }}
          >
            <span className="badge" data-status={claim.status}>
              {claim.claimType}
            </span>{' '}
            {claim.statement}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Fact({
  term,
  value,
  mono = false,
}: {
  term: string;
  value: string;
  mono?: boolean;
}): ReactElement {
  return (
    <>
      <dt>{term}</dt>
      <dd className={mono ? 'drawer__mono' : undefined}>{value}</dd>
    </>
  );
}

function participantName(ledger: Ledger, participantId: string | null): string {
  if (participantId === null) return 'a person';
  const entry = ledger.roster.find((candidate) => candidate.participantId === participantId);
  return entry ? `${entry.model.vendorId} · ${entry.model.modelId}` : participantId;
}

function Legend(): ReactElement {
  return (
    <ul className="graph__legend" aria-label="Legend">
      {['asserted', 'supported', 'disputed', 'unresolved', 'refuted', 'withdrawn'].map((status) => (
        <li key={status} data-status={status}>
          {status}
        </li>
      ))}
      <li data-kind="evidence">evidence</li>
      <li data-kind="dispute">dispute → claim</li>
    </ul>
  );
}

/** Reliability per participant — shown for judgement, never read to decide. */
function CalibrationTable({ ledger }: { ledger: Ledger }): ReactElement | null {
  if (ledger.calibration.length === 0) return null;
  const names = new Map(
    ledger.roster.map((entry) => [
      entry.participantId,
      `${entry.model.vendorId} · ${entry.model.modelId}`,
    ]),
  );

  return (
    <section className="calibration">
      <h2 className="calibration__title">Calibration</h2>
      <p className="calibration__note">
        Brier score of each participant’s sealed positions against disputes the evidence settled. 0
        is perfect; 0.25 is what always saying 50% earns. Shown for your judgement — Sheep never
        uses it to decide anything.
      </p>
      <table className="calibration__table">
        <thead>
          <tr>
            <th scope="col">Participant</th>
            <th scope="col">Scored</th>
            <th scope="col">Brier</th>
            <th scope="col">Stance changes</th>
          </tr>
        </thead>
        <tbody>
          {ledger.calibration.map((row) => (
            <tr key={row.participantId}>
              <td>{names.get(row.participantId) ?? row.participantId}</td>
              <td>{row.scored}</td>
              <td>{row.brier === null ? '—' : row.brier.toFixed(3)}</td>
              <td>
                {
                  ledger.movements.filter(
                    (movement) =>
                      movement.participantId === row.participantId && movement.stanceChanged,
                  ).length
                }
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RecordClaim({
  client,
  sessionId,
  onRecorded,
}: {
  client: IpcClient;
  sessionId: string;
  onRecorded: (reply: IpcResponse<'sheep:claim-record'>) => void;
}): ReactElement {
  const [claimType, setClaimType] = useState<ClaimType>('CONJECTURE');
  const [statement, setStatement] = useState('');
  const [evidenceKind, setEvidenceKind] = useState<EvidenceKind | ''>('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const reply = await client.invoke('sheep:claim-record', {
        sessionId,
        claimType,
        statement: statement.trim(),
        support:
          evidenceKind === '' || ref.trim() === '' ? [] : [{ kind: evidenceKind, ref: ref.trim() }],
      });
      setStatement('');
      setRef('');
      onRecorded(reply);
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="record-claim"
      data-sheep-record-claim
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="calibration__title">Record a claim</h2>
      <div className="record-claim__row">
        <label className="field field--inline">
          <span className="field__label">Type</span>
          <select
            className="field__input"
            value={claimType}
            onChange={(event) => {
              setClaimType(event.target.value as ClaimType);
            }}
          >
            {CLAIM_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline">
          <span className="field__label">Evidence</span>
          <select
            className="field__input"
            value={evidenceKind}
            onChange={(event) => {
              setEvidenceKind(event.target.value as EvidenceKind | '');
            }}
          >
            <option value="">none</option>
            {EVIDENCE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Reference</span>
          <input
            className="field__input"
            value={ref}
            placeholder="execution id, doi:…, claim id"
            disabled={evidenceKind === ''}
            onChange={(event) => {
              setRef(event.target.value);
            }}
          />
        </label>
      </div>
      <label className="field">
        <span className="field__label">Statement — one falsifiable sentence</span>
        <textarea
          className="field__input field__input--multiline"
          rows={2}
          maxLength={2_000}
          value={statement}
          onChange={(event) => {
            setStatement(event.target.value);
          }}
        />
      </label>
      {problem !== null && (
        <p className="notice notice--error" role="alert">
          {problem}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="button" disabled={busy || statement.trim() === ''}>
          {busy ? 'Recording…' : 'Record claim'}
        </button>
      </div>
    </form>
  );
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // The ledger's own sentence is the useful part; the IPC wrapping is not.
  const rule = /LEDGER_[A-Z_]+: .*/.exec(message);
  return rule ? rule[0] : message;
}

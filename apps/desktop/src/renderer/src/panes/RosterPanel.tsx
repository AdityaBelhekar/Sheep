import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { PARTICIPANT_ROLES, type ParticipantRole, type RosterEntry } from '@sheep/core';
import type { IpcClient, IpcResponse } from '@sheep/ipc';
import { EarTag, tagIndex } from '../components/EarTag';

type DetailReply = IpcResponse<'sheep:session-get'>;
type ModelsReply = IpcResponse<'sheep:models-list'>;
type ModelRow = ModelsReply['models'][number];

type DetailState =
  { kind: 'loading' } | { kind: 'ready'; detail: DetailReply } | { kind: 'error'; message: string };

/** What the attach form is describing. `''` for a cap means "no cap". */
interface AttachDraft {
  readonly key: string;
  readonly weight: string;
  readonly budgetCapUsd: string;
  readonly preferredRole: ParticipantRole | '';
}

const EMPTY_ATTACH: AttachDraft = { key: '', weight: '1', budgetCapUsd: '', preferredRole: '' };

/**
 * One session's roster: which models are attached, and on what terms.
 *
 * The vendor count is shown prominently because it is the precondition for P1 —
 * a critique is only independent if it comes from a different company's weights
 * than the claim it attacks, so a single-vendor roster cannot run the protocol
 * however many models are in it. The panel says so rather than letting the
 * session fail later for a reason nobody connects to this screen.
 */
export function RosterPanel({
  client,
  sessionId,
  onStoreChanged,
  onClose,
}: {
  client: IpcClient | undefined;
  sessionId: string;
  /** Called after this panel appends events, so the shell can re-read the log. */
  onStoreChanged: () => void;
  onClose: () => void;
}): ReactElement {
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [models, setModels] = useState<ModelsReply | null>(null);
  const [attach, setAttach] = useState<AttachDraft>(EMPTY_ATTACH);
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(
    (signal?: { cancelled: boolean }) => {
      if (!client) {
        setState({ kind: 'error', message: 'the preload bridge is unavailable' });
        return;
      }
      client
        .invoke('sheep:session-get', { sessionId })
        .then((detail) => {
          if (!signal?.cancelled) setState({ kind: 'ready', detail });
        })
        .catch((error: unknown) => {
          if (!signal?.cancelled) setState({ kind: 'error', message: describe(error) });
        });
    },
    [client, sessionId],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    setState({ kind: 'loading' });
    setCapDraft(null);
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  // The catalogue needs the network, so it is fetched once and refreshed on
  // demand rather than on every render of the panel.
  useEffect(() => {
    if (!client) return;
    const signal = { cancelled: false };
    client
      .invoke('sheep:models-list', {})
      .then((reply) => {
        if (!signal.cancelled) setModels(reply);
      })
      .catch(() => {
        // A catalogue that cannot be read leaves the attach form empty, which
        // the empty state already explains; it is not worth an alert.
      });
    return () => {
      signal.cancelled = true;
    };
  }, [client]);

  const run = async (name: string, action: () => Promise<DetailReply>): Promise<void> => {
    setBusy(name);
    setProblem(null);
    try {
      setState({ kind: 'ready', detail: await action() });
      onStoreChanged();
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(null);
    }
  };

  const roster = state.kind === 'ready' ? state.detail.roster : [];
  const attached = useMemo(() => roster.filter((entry) => entry.detachedAt === null), [roster]);
  const vendors = useMemo(() => new Set(attached.map((entry) => entry.model.vendorId)), [attached]);

  const byKey = useMemo(() => {
    const map = new Map<string, ModelRow>();
    for (const model of models?.models ?? []) map.set(modelKey(model), model);
    return map;
  }, [models]);

  const chosen = byKey.get(attach.key);

  const doAttach = (): void => {
    if (!client || !chosen) return;
    void run('attach', async () => {
      const reply = await client.invoke('sheep:roster-attach', {
        sessionId,
        connectionId: chosen.connectionId,
        modelId: chosen.modelId,
        weight: clampWeight(attach.weight),
        budgetCapUsd: parseUsd(attach.budgetCapUsd),
        preferredRole: attach.preferredRole === '' ? null : attach.preferredRole,
      });
      setAttach(EMPTY_ATTACH);
      return reply;
    });
  };

  const reconfigure = (entry: RosterEntry, changes: Partial<RosterEntry>): void => {
    if (!client) return;
    void run(`configure:${entry.participantId}`, () =>
      client.invoke('sheep:roster-reconfigure', {
        sessionId,
        participantId: entry.participantId,
        weight: changes.weight ?? entry.weight,
        budgetCapUsd:
          changes.budgetCapUsd === undefined ? entry.budgetCapUsd : changes.budgetCapUsd,
        preferredRole:
          changes.preferredRole === undefined ? entry.preferredRole : changes.preferredRole,
      }),
    );
  };

  if (state.kind === 'loading') return <p className="notice">Reading the session…</p>;

  if (state.kind === 'error') {
    return (
      <p className="notice notice--error" role="alert">
        Could not read the session: {state.message}
      </p>
    );
  }

  const session = state.detail.session;
  const capValue =
    capDraft ?? (session.budget.capUsd === null ? '' : String(session.budget.capUsd));

  return (
    <section
      className="roster"
      data-sheep-roster={String(attached.length)}
      data-sheep-roster-vendors={String(vendors.size)}
      data-sheep-roster-session={sessionId}
    >
      <header className="roster__head">
        <div>
          <h2 className="roster__title">{session.title}</h2>
          <p className="roster__question">{session.question}</p>
        </div>
        <div className="button-row">
          <button
            className="button"
            type="button"
            disabled={vendors.size < 2}
            title={vendors.size < 2 ? 'Attach models from two vendors first' : undefined}
            onClick={() => {
              window.location.hash = '#/conversation';
            }}
          >
            Go to the protocol
          </button>
          <button className="button button--quiet" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      <div className="roster__budget">
        <div className="field field--inline">
          <label className="field__label" htmlFor="session-cap">
            Session cap (USD)
          </label>
          <input
            id="session-cap"
            className="field__input field__input--narrow"
            inputMode="decimal"
            value={capValue}
            onChange={(event) => {
              setCapDraft(event.target.value);
            }}
          />
        </div>
        <button
          className="button button--quiet"
          type="button"
          disabled={busy !== null || !client || parseUsd(capValue) === null}
          onClick={() => {
            const capUsd = parseUsd(capValue);
            if (!client || capUsd === null) return;
            void run('cap', async () => {
              const reply = await client.invoke('sheep:session-budget-set', { sessionId, capUsd });
              setCapDraft(null);
              return reply;
            });
          }}
        >
          {busy === 'cap' ? 'Saving…' : 'Set cap'}
        </button>
        <span className="roster__spent">
          {formatUsd(session.budget.spentUsd)} spent
          {session.budget.capUsd === null ? '' : ` of ${formatUsd(session.budget.capUsd)}`}
        </span>
      </div>

      <p
        className={vendors.size >= 2 ? 'roster__vendors' : 'roster__vendors roster__vendors--warn'}
      >
        {attached.length === 0
          ? 'No models attached yet.'
          : `${String(attached.length)} model${attached.length === 1 ? '' : 's'} from ${String(
              vendors.size,
            )} vendor${vendors.size === 1 ? '' : 's'}`}
        {attached.length > 0 && vendors.size < 2
          ? ' — a second vendor is needed before a critique can be independent.'
          : ''}
      </p>

      {problem !== null && (
        <p className="notice notice--error" role="alert">
          {problem}
        </p>
      )}

      {attached.length > 0 && (
        <ul className="roster__list">
          {attached.map((entry) => (
            <li className="roster__entry" key={entry.participantId}>
              <div className="roster__entry-head">
                <EarTag model={entry.model} index={tagIndex(roster, entry.participantId)} />
                <span className="badge">{entry.model.vendorId}</span>
              </div>

              <div className="roster__controls">
                <label className="field field--inline">
                  <span className="field__label">Weight</span>
                  <input
                    className="field__input field__input--narrow"
                    inputMode="decimal"
                    defaultValue={String(entry.weight)}
                    disabled={busy !== null}
                    onBlur={(event) => {
                      const weight = clampWeight(event.target.value);
                      if (weight !== entry.weight) reconfigure(entry, { weight });
                    }}
                  />
                </label>

                <label className="field field--inline">
                  <span className="field__label">Cap (USD)</span>
                  <input
                    className="field__input field__input--narrow"
                    inputMode="decimal"
                    placeholder="none"
                    defaultValue={entry.budgetCapUsd === null ? '' : String(entry.budgetCapUsd)}
                    disabled={busy !== null}
                    onBlur={(event) => {
                      const budgetCapUsd = parseUsd(event.target.value);
                      if (budgetCapUsd !== entry.budgetCapUsd) reconfigure(entry, { budgetCapUsd });
                    }}
                  />
                </label>

                <label className="field field--inline">
                  <span className="field__label">Preferred role</span>
                  <select
                    className="field__input field__input--narrow"
                    value={entry.preferredRole ?? ''}
                    disabled={busy !== null}
                    onChange={(event) => {
                      const value = event.target.value;
                      reconfigure(entry, {
                        preferredRole: value === '' ? null : (value as ParticipantRole),
                      });
                    }}
                  >
                    <option value="">no preference</option>
                    {PARTICIPANT_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  className="button button--danger"
                  type="button"
                  disabled={busy !== null || !client}
                  onClick={() => {
                    if (!client) return;
                    void run(`detach:${entry.participantId}`, () =>
                      client.invoke('sheep:roster-detach', {
                        sessionId,
                        participantId: entry.participantId,
                      }),
                    );
                  }}
                >
                  Detach
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form
        className="roster__attach"
        onSubmit={(event) => {
          event.preventDefault();
          doAttach();
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="attach-model">
            Attach a model
          </label>
          <select
            id="attach-model"
            className="field__input"
            value={attach.key}
            onChange={(event) => {
              setAttach({ ...attach, key: event.target.value });
            }}
          >
            <option value="">
              {byKey.size === 0
                ? 'no models — add a connection and test it first'
                : 'choose a model…'}
            </option>
            {[...byKey.values()].map((model) => (
              <option key={modelKey(model)} value={modelKey(model)}>
                {model.connectionLabel} · {model.displayName}
                {model.local ? ' (local)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="roster__controls">
          <label className="field field--inline">
            <span className="field__label">Weight</span>
            <input
              className="field__input field__input--narrow"
              inputMode="decimal"
              value={attach.weight}
              onChange={(event) => {
                setAttach({ ...attach, weight: event.target.value });
              }}
            />
          </label>

          <label className="field field--inline">
            <span className="field__label">Cap (USD)</span>
            <input
              className="field__input field__input--narrow"
              inputMode="decimal"
              placeholder="none"
              value={attach.budgetCapUsd}
              onChange={(event) => {
                setAttach({ ...attach, budgetCapUsd: event.target.value });
              }}
            />
          </label>

          <label className="field field--inline">
            <span className="field__label">Preferred role</span>
            <select
              className="field__input field__input--narrow"
              value={attach.preferredRole}
              onChange={(event) => {
                setAttach({
                  ...attach,
                  preferredRole: event.target.value as ParticipantRole | '',
                });
              }}
            >
              <option value="">no preference</option>
              {PARTICIPANT_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>

          <button className="button" type="submit" disabled={!chosen || busy !== null}>
            {busy === 'attach' ? 'Attaching…' : 'Attach'}
          </button>
        </div>

        {chosen && (
          <p className="roster__price">
            {chosen.contextWindowTokens.toLocaleString()} token context ·{' '}
            {chosen.inputPerMTokUsd === null
              ? 'price unknown — a capped session will refuse to run it'
              : `$${String(chosen.inputPerMTokUsd)} in / $${String(
                  chosen.outputPerMTokUsd ?? 0,
                )} out per Mtok`}
          </p>
        )}

        {models !== null && models.failures.length > 0 && (
          <p className="roster__price">
            {models.failures.length} connection
            {models.failures.length === 1 ? '' : 's'} could not be listed:{' '}
            {models.failures.map((failure) => failure.adapterId).join(', ')}
          </p>
        )}
      </form>
    </section>
  );
}

function modelKey(model: ModelRow): string {
  return `${model.connectionId} ${model.modelId}`;
}

/** Weight is bounded by the domain; a typo becomes the nearest legal value. */
function clampWeight(raw: string): number {
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(10, Math.max(0, parsed));
}

/** Empty means "no cap", which is deliberately not the same as zero. */
function parseUsd(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

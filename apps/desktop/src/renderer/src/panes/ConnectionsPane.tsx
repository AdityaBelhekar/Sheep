import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  CONNECTION_KINDS,
  LOCAL_PROVIDER_IDS,
  OPENAI_PRESET_IDS,
  connectionConfigIssues,
  requiresSecret,
  usesInteractiveSignIn,
  vendorIdForConfig,
  type Connection,
  type ConnectionConfig,
  type ConnectionKind,
  type LocalProviderId,
  type OpenAiPresetId,
} from '@sheep/core';
import type { IpcClient, IpcResponse } from '@sheep/ipc';
import { paneById } from '@shared/panes';

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; reply: IpcResponse<'sheep:connections-list'> }
  | { kind: 'error'; message: string };

type LocalState = IpcResponse<'sheep:local-providers-detect'>['providers'];

/** What the form is currently describing. Not a connection until it is saved. */
interface Draft {
  /** Set when editing an existing connection. */
  readonly connectionId: string | null;
  readonly label: string;
  readonly kind: ConnectionKind;
  readonly preset: OpenAiPresetId;
  readonly provider: LocalProviderId;
  readonly baseUrl: string;
  readonly vendorId: string;
  readonly endpoint: string;
  readonly apiVersion: string;
  readonly clientId: string;
  readonly secret: string;
}

const KIND_LABELS: Record<ConnectionKind, string> = {
  anthropic: 'Anthropic',
  'openai-compatible': 'OpenAI-compatible',
  'azure-openai': 'Azure OpenAI',
  google: 'Google (API key)',
  'google-oauth': 'Google (sign in)',
  local: 'Local runtime',
};

const HEALTH_LABELS: Record<Connection['health'], string> = {
  unknown: 'untested',
  ok: 'reachable',
  unauthorized: 'key refused',
  unreachable: 'unreachable',
  misconfigured: 'misconfigured',
};

const EMPTY_DRAFT: Draft = {
  connectionId: null,
  label: '',
  kind: 'anthropic',
  preset: 'openai',
  provider: 'ollama',
  baseUrl: '',
  vendorId: '',
  endpoint: '',
  apiVersion: '2024-10-21',
  clientId: '',
  secret: '',
};

/**
 * Add, edit, delete and test a connection.
 *
 * The form deliberately builds a real `ConnectionConfig` on every keystroke and
 * shows what the domain says is wrong with it, rather than inventing its own
 * validation — so the rules the main process enforces are the rules the user
 * sees, and there is no second copy of them here to drift.
 */
export function ConnectionsPane({ client }: { client: IpcClient | undefined }): ReactElement {
  const pane = paneById('connections');
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalState | null>(null);

  const load = useCallback(
    (signal?: { cancelled: boolean }) => {
      if (!client) {
        setState({ kind: 'error', message: 'the preload bridge is unavailable' });
        return;
      }
      client
        .invoke('sheep:connections-list', {})
        .then((reply) => {
          if (!signal?.cancelled) setState({ kind: 'ready', reply });
        })
        .catch((error: unknown) => {
          if (!signal?.cancelled) setState({ kind: 'error', message: describe(error) });
        });
    },
    [client],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  const config = useMemo(() => configFromDraft(draft), [draft]);
  const issues = useMemo(() => (config ? connectionConfigIssues(config) : []), [config]);
  const needsSecret = config !== null && requiresSecret(config) && !usesInteractiveSignIn(config);
  const editing = draft.connectionId !== null;

  // An edit keeps the stored secret unless a replacement is typed; a new
  // connection that needs one cannot be saved without it.
  const canSave =
    client !== undefined &&
    config !== null &&
    issues.length === 0 &&
    draft.label.trim() !== '' &&
    (editing || !needsSecret || draft.secret !== '');

  const run = async (
    name: string,
    action: () => Promise<IpcResponse<'sheep:connections-list'>>,
  ): Promise<void> => {
    setBusy(name);
    setProblem(null);
    try {
      setState({ kind: 'ready', reply: await action() });
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(null);
    }
  };

  const save = (): void => {
    if (!client || !config || !canSave) return;
    void run('save', async () => {
      const secret = draft.secret === '' ? undefined : draft.secret;
      const reply =
        draft.connectionId === null
          ? await client.invoke('sheep:connection-create', {
              label: draft.label.trim(),
              config,
              ...(secret === undefined ? {} : { secret }),
            })
          : await client.invoke('sheep:connection-update', {
              connectionId: draft.connectionId,
              label: draft.label.trim(),
              config,
              ...(secret === undefined ? {} : { secret }),
            });
      setDraft(EMPTY_DRAFT);
      return reply;
    });
  };

  const detectLocal = (): void => {
    if (!client) return;
    setBusy('detect');
    client
      .invoke('sheep:local-providers-detect', {})
      .then((reply) => {
        setLocal(reply.providers);
      })
      .catch((error: unknown) => {
        setProblem(describe(error));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const connections = state.kind === 'ready' ? state.reply.connections : [];

  return (
    <section
      className="pane"
      data-pane="connections"
      data-sheep-connections={state.kind === 'ready' ? String(connections.length) : state.kind}
      data-sheep-vault={state.kind === 'ready' ? state.reply.vaultBackend : ''}
    >
      <header className="pane__header">
        <h1 className="pane__title">{pane.label}</h1>
        <p className="pane__summary">{pane.summary}</p>
      </header>

      {state.kind === 'ready' && (
        <p className="pane__note">
          Secrets are stored in {state.reply.vaultDescription}. The database keeps only a reference.
        </p>
      )}

      <form
        className="new-session"
        data-sheep-connection-form={editing ? 'edit' : 'create'}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="connection-label">
            Label
          </label>
          <input
            id="connection-label"
            className="field__input"
            value={draft.label}
            maxLength={200}
            placeholder="Anthropic (personal)"
            onChange={(event) => {
              setDraft({ ...draft, label: event.target.value });
            }}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="connection-kind">
            Provider
          </label>
          <select
            id="connection-kind"
            className="field__input"
            value={draft.kind}
            onChange={(event) => {
              setDraft({ ...draft, kind: event.target.value as ConnectionKind });
            }}
          >
            {CONNECTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>

        {draft.kind === 'openai-compatible' && (
          <div className="field">
            <label className="field__label" htmlFor="connection-preset">
              Endpoint
            </label>
            <select
              id="connection-preset"
              className="field__input"
              value={draft.preset}
              onChange={(event) => {
                setDraft({ ...draft, preset: event.target.value as OpenAiPresetId });
              }}
            >
              {OPENAI_PRESET_IDS.map((preset) => (
                <option key={preset} value={preset}>
                  {preset}
                </option>
              ))}
            </select>
          </div>
        )}

        {draft.kind === 'local' && (
          <div className="field">
            <label className="field__label" htmlFor="connection-provider">
              Runtime
            </label>
            <select
              id="connection-provider"
              className="field__input"
              value={draft.provider}
              onChange={(event) => {
                setDraft({ ...draft, provider: event.target.value as LocalProviderId });
              }}
            >
              {LOCAL_PROVIDER_IDS.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </div>
        )}

        {draft.kind === 'azure-openai' && (
          <>
            <TextField
              id="connection-endpoint"
              label="Resource endpoint"
              value={draft.endpoint}
              placeholder="https://my-resource.openai.azure.com"
              onChange={(endpoint) => {
                setDraft({ ...draft, endpoint });
              }}
            />
            <TextField
              id="connection-api-version"
              label="API version"
              value={draft.apiVersion}
              placeholder="2024-10-21"
              onChange={(apiVersion) => {
                setDraft({ ...draft, apiVersion });
              }}
            />
          </>
        )}

        {draft.kind === 'google-oauth' && (
          <TextField
            id="connection-client-id"
            label="OAuth client id"
            value={draft.clientId}
            placeholder="1234.apps.googleusercontent.com"
            onChange={(clientId) => {
              setDraft({ ...draft, clientId });
            }}
          />
        )}

        {draft.kind !== 'azure-openai' && draft.kind !== 'google-oauth' && (
          <TextField
            id="connection-base-url"
            label={
              draft.kind === 'openai-compatible' && draft.preset === 'custom'
                ? 'Base URL'
                : 'Base URL (optional)'
            }
            value={draft.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(baseUrl) => {
              setDraft({ ...draft, baseUrl });
            }}
          />
        )}

        {draft.kind === 'openai-compatible' && draft.preset === 'custom' && (
          <TextField
            id="connection-vendor"
            label="Vendor id"
            value={draft.vendorId}
            placeholder="mistral"
            onChange={(vendorId) => {
              setDraft({ ...draft, vendorId });
            }}
          />
        )}

        {needsSecret && (
          <div className="field">
            <label className="field__label" htmlFor="connection-secret">
              API key{editing ? ' (leave blank to keep the stored one)' : ''}
            </label>
            <input
              id="connection-secret"
              className="field__input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft.secret}
              onChange={(event) => {
                setDraft({ ...draft, secret: event.target.value });
              }}
            />
          </div>
        )}

        {issues.length > 0 && (
          <p className="notice notice--error" role="alert">
            {issues.join(' · ')}
          </p>
        )}

        <div className="button-row">
          <button className="button" type="submit" disabled={!canSave || busy !== null}>
            {busy === 'save' ? 'Saving…' : editing ? 'Save changes' : 'Add connection'}
          </button>
          {editing && (
            <button
              className="button button--quiet"
              type="button"
              onClick={() => {
                setDraft(EMPTY_DRAFT);
              }}
            >
              Cancel
            </button>
          )}
          <button
            className="button button--quiet"
            type="button"
            disabled={busy !== null}
            onClick={detectLocal}
          >
            {busy === 'detect' ? 'Looking…' : 'Detect local runtimes'}
          </button>
        </div>
      </form>

      {problem !== null && (
        <p className="notice notice--error" role="alert">
          {problem}
        </p>
      )}

      {local !== null && (
        <ul className="probe-list" data-sheep-local-probe={String(local.length)}>
          {local.map((provider) => (
            <li className="probe" key={provider.id}>
              <span className="badge" data-status={provider.status}>
                {provider.status}
              </span>
              <span className="probe__name">{provider.displayName}</span>
              <span className="probe__detail">
                {provider.status === 'running'
                  ? `${String(provider.models.length)} model${
                      provider.models.length === 1 ? '' : 's'
                    } at ${provider.baseUrl}`
                  : `not found — ${provider.install}`}
              </span>
            </li>
          ))}
        </ul>
      )}

      {state.kind === 'loading' && <p className="notice">Reading connections…</p>}

      {state.kind === 'error' && (
        <p className="notice notice--error" role="alert">
          Could not read connections: {state.message}
        </p>
      )}

      {state.kind === 'ready' && connections.length === 0 && (
        <div className="empty">
          <p className="empty__title">No connections yet</p>
          <p className="empty__body">
            Sheep needs at least two vendors to do its job: a critique only counts as independent if
            it comes from a different company&rsquo;s weights than the claim it attacks.
          </p>
        </div>
      )}

      {state.kind === 'ready' && connections.length > 0 && (
        <ul className="session-list">
          {connections.map((connection) => (
            <li className="session" key={connection.connectionId}>
              <div className="session__head">
                <h2 className="session__title">{connection.label}</h2>
                <span className="badge" data-status={connection.health}>
                  {HEALTH_LABELS[connection.health]}
                </span>
              </div>
              <p className="session__question">
                {KIND_LABELS[connection.config.kind]} · vendor {connection.vendorId} ·{' '}
                {connection.credentialRef === null ? 'no credential' : 'key in the vault'}
                {connection.enabled ? '' : ' · disabled'}
              </p>
              {connection.healthDetail !== null && (
                <p className="session__detail">{connection.healthDetail}</p>
              )}
              <div className="button-row">
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={busy !== null || !client}
                  onClick={() => {
                    if (!client) return;
                    void run(`test:${connection.connectionId}`, async () => {
                      const reply = await client.invoke('sheep:connection-test', {
                        connectionId: connection.connectionId,
                      });
                      return reply;
                    });
                  }}
                >
                  {busy === `test:${connection.connectionId}` ? 'Testing…' : 'Test'}
                </button>

                {usesInteractiveSignIn(connection.config) && (
                  <button
                    className="button button--quiet"
                    type="button"
                    disabled={busy !== null || !client}
                    onClick={() => {
                      if (!client) return;
                      void run(`signin:${connection.connectionId}`, () =>
                        client.invoke('sheep:connection-sign-in', {
                          connectionId: connection.connectionId,
                        }),
                      );
                    }}
                  >
                    {busy === `signin:${connection.connectionId}`
                      ? 'Waiting for the browser…'
                      : 'Sign in'}
                  </button>
                )}

                <button
                  className="button button--quiet"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    setDraft(draftFrom(connection));
                  }}
                >
                  Edit
                </button>

                <button
                  className="button button--quiet"
                  type="button"
                  disabled={busy !== null || !client}
                  onClick={() => {
                    if (!client) return;
                    void run(`enable:${connection.connectionId}`, () =>
                      client.invoke('sheep:connection-update', {
                        connectionId: connection.connectionId,
                        enabled: !connection.enabled,
                      }),
                    );
                  }}
                >
                  {connection.enabled ? 'Disable' : 'Enable'}
                </button>

                <button
                  className="button button--danger"
                  type="button"
                  disabled={busy !== null || !client}
                  onClick={() => {
                    if (!client) return;
                    void run(`delete:${connection.connectionId}`, () =>
                      client.invoke('sheep:connection-delete', {
                        connectionId: connection.connectionId,
                      }),
                    );
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TextField({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="field__input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}

/**
 * The draft as a `ConnectionConfig`, or null if it is not one yet.
 *
 * Null means "still being typed", which is different from invalid: the issues
 * list handles rules a complete config can still break, and this handles a
 * required field that is simply empty so far.
 */
function configFromDraft(draft: Draft): ConnectionConfig | null {
  const baseUrl = draft.baseUrl.trim();
  const optionalBase = baseUrl === '' ? {} : { baseUrl };

  switch (draft.kind) {
    case 'anthropic':
      return { kind: 'anthropic', ...optionalBase };
    case 'google':
      return { kind: 'google', ...optionalBase };
    case 'local':
      return { kind: 'local', provider: draft.provider, ...optionalBase };
    case 'openai-compatible': {
      const vendorId = draft.vendorId.trim();
      return {
        kind: 'openai-compatible',
        preset: draft.preset,
        ...optionalBase,
        ...(vendorId === '' ? {} : { vendorId }),
      };
    }
    case 'azure-openai': {
      const endpoint = draft.endpoint.trim();
      const apiVersion = draft.apiVersion.trim();
      if (endpoint === '' || apiVersion === '') return null;
      return { kind: 'azure-openai', endpoint, apiVersion };
    }
    case 'google-oauth': {
      const clientId = draft.clientId.trim();
      return clientId === '' ? null : { kind: 'google-oauth', clientId };
    }
  }
}

/** Loads an existing connection into the form. Never loads its secret. */
function draftFrom(connection: Connection): Draft {
  const config = connection.config;
  return {
    ...EMPTY_DRAFT,
    connectionId: connection.connectionId,
    label: connection.label,
    kind: config.kind,
    preset: config.kind === 'openai-compatible' ? config.preset : EMPTY_DRAFT.preset,
    provider: config.kind === 'local' ? config.provider : EMPTY_DRAFT.provider,
    baseUrl: 'baseUrl' in config ? (config.baseUrl ?? '') : '',
    vendorId:
      config.kind === 'openai-compatible' ? (config.vendorId ?? '') : vendorIdForConfig(config),
    endpoint: config.kind === 'azure-openai' ? config.endpoint : '',
    apiVersion: config.kind === 'azure-openai' ? config.apiVersion : EMPTY_DRAFT.apiVersion,
    clientId: config.kind === 'google-oauth' ? config.clientId : '',
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

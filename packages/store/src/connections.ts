import { randomBytes, randomUUID } from 'node:crypto';
import {
  adapterPrefixFor,
  connectionConfigSchema,
  connectionSchema,
  vendorIdForConfig,
  type Connection,
  type ConnectionCheck,
  type ConnectionConfig,
} from '@sheep/core';
import { canonicalJson, parseJson } from './events/json';
import type { SqliteDatabase } from './sqlite/types';

export class ConnectionRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionRegistryError';
  }
}

/**
 * A fresh registry key, prefixed with something a human can recognise.
 *
 * The suffix is what lets the same provider be configured twice — a work key
 * and a personal one — without the two colliding in the adapter registry.
 */
export function newAdapterId(config: ConnectionConfig): string {
  return `${adapterPrefixFor(config)}-${randomBytes(4).toString('hex')}`;
}

export interface AddConnectionInput {
  readonly label: string;
  readonly config: ConnectionConfig;
  /** Null for a local runtime, which needs no credential. */
  readonly credentialRef?: string | null;
  readonly enabled?: boolean;
  /** Supplied only when importing; normally generated. */
  readonly connectionId?: string;
  readonly adapterId?: string;
}

export interface UpdateConnectionInput {
  readonly label?: string;
  readonly config?: ConnectionConfig;
  readonly credentialRef?: string | null;
  readonly enabled?: boolean;
}

type ConnectionRow = {
  connection_id: string;
  label: string;
  adapter_id: string;
  kind: string;
  vendor_id: string;
  config: string;
  credential_ref: string | null;
  enabled: number;
  health: string;
  health_detail: string | null;
  model_count: number | null;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS =
  'connection_id, label, adapter_id, kind, vendor_id, config, credential_ref, enabled, ' +
  'health, health_detail, model_count, checked_at, created_at, updated_at';

/**
 * Stored connections.
 *
 * The registry owns two derived values so nothing else has to remember to keep
 * them in step: `vendor_id`, which is computed from the config every time it is
 * written, and `adapter_id`, which is minted once and then never changes — a
 * live adapter is looked up by it, so a connection that renamed its key on
 * every edit would drop out of the registry mid-session.
 *
 * Editing a connection deliberately does *not* touch its health. A row that
 * says `ok` because it was tested an hour ago is stale the moment its base URL
 * changes, so `update` resets the check; what it will not do is invent a new
 * verdict without asking the provider.
 */
export class ConnectionRegistry {
  readonly #db: SqliteDatabase;
  readonly #now: () => Date;

  constructor(db: SqliteDatabase, options: { now?: () => Date } = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  add(input: AddConnectionInput): Connection {
    const config = connectionConfigSchema.parse(input.config);
    const at = this.#now().toISOString();

    const record = connectionSchema.parse({
      connectionId: input.connectionId ?? randomUUID(),
      label: input.label,
      adapterId: input.adapterId ?? newAdapterId(config),
      vendorId: vendorIdForConfig(config),
      config,
      credentialRef: input.credentialRef ?? null,
      enabled: input.enabled ?? true,
      health: 'unknown',
      healthDetail: null,
      modelCount: null,
      checkedAt: null,
      createdAt: at,
      updatedAt: at,
    } satisfies Connection);

    this.#db.run(
      `INSERT INTO connections (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.connectionId,
        record.label,
        record.adapterId,
        record.config.kind,
        record.vendorId,
        canonicalJson(record.config),
        record.credentialRef,
        record.enabled ? 1 : 0,
        record.health,
        record.healthDetail,
        record.modelCount,
        record.checkedAt,
        record.createdAt,
        record.updatedAt,
      ],
    );
    return record;
  }

  get(connectionId: string): Connection | undefined {
    const row = this.#db.get<ConnectionRow>(
      `SELECT ${COLUMNS} FROM connections WHERE connection_id = ?`,
      [connectionId],
    );
    return row ? toConnection(row) : undefined;
  }

  getByAdapterId(adapterId: string): Connection | undefined {
    const row = this.#db.get<ConnectionRow>(
      `SELECT ${COLUMNS} FROM connections WHERE adapter_id = ?`,
      [adapterId],
    );
    return row ? toConnection(row) : undefined;
  }

  list(): Connection[] {
    return this.#db
      .all<ConnectionRow>(`SELECT ${COLUMNS} FROM connections ORDER BY created_at, connection_id`)
      .map(toConnection);
  }

  /** Only the connections that should actually be registered as adapters. */
  listEnabled(): Connection[] {
    return this.list().filter((connection) => connection.enabled);
  }

  count(): number {
    return this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM connections')?.n ?? 0;
  }

  /**
   * Applies whichever fields were given, and resets the health check.
   *
   * The reset is the point: a verdict recorded against the old settings is not
   * evidence about the new ones.
   */
  update(connectionId: string, input: UpdateConnectionInput): Connection {
    const existing = this.get(connectionId);
    if (!existing) throw new ConnectionRegistryError(`unknown connection: ${connectionId}`);

    const config = input.config ? connectionConfigSchema.parse(input.config) : existing.config;
    const next = connectionSchema.parse({
      ...existing,
      label: input.label ?? existing.label,
      config,
      vendorId: vendorIdForConfig(config),
      credentialRef:
        input.credentialRef === undefined ? existing.credentialRef : input.credentialRef,
      enabled: input.enabled ?? existing.enabled,
      health: 'unknown',
      healthDetail: null,
      modelCount: null,
      checkedAt: null,
      updatedAt: this.#now().toISOString(),
    } satisfies Connection);

    this.#db.run(
      `UPDATE connections SET
         label = ?, kind = ?, vendor_id = ?, config = ?, credential_ref = ?, enabled = ?,
         health = ?, health_detail = ?, model_count = ?, checked_at = ?, updated_at = ?
       WHERE connection_id = ?`,
      [
        next.label,
        next.config.kind,
        next.vendorId,
        canonicalJson(next.config),
        next.credentialRef,
        next.enabled ? 1 : 0,
        next.health,
        next.healthDetail,
        next.modelCount,
        next.checkedAt,
        next.updatedAt,
        connectionId,
      ],
    );
    return next;
  }

  /** Records what a test found. */
  recordCheck(connectionId: string, check: ConnectionCheck): boolean {
    return (
      this.#db.run(
        `UPDATE connections
           SET health = ?, health_detail = ?, model_count = ?, checked_at = ?, updated_at = ?
         WHERE connection_id = ?`,
        [
          check.health,
          check.detail,
          check.modelCount,
          check.checkedAt,
          check.checkedAt,
          connectionId,
        ],
      ).changes > 0
    );
  }

  /**
   * Forgets the connection.
   *
   * Deleting the secret is the caller's job, as it is for credentials: this
   * class has no way to reach the vault, which is the property that makes
   * "no secret is stored here" checkable rather than merely claimed.
   */
  remove(connectionId: string): boolean {
    return (
      this.#db.run('DELETE FROM connections WHERE connection_id = ?', [connectionId]).changes > 0
    );
  }
}

function toConnection(row: ConnectionRow): Connection {
  return connectionSchema.parse({
    connectionId: row.connection_id,
    label: row.label,
    adapterId: row.adapter_id,
    vendorId: row.vendor_id,
    config: parseJson(row.config),
    credentialRef: row.credential_ref,
    enabled: row.enabled !== 0,
    health: row.health,
    healthDetail: row.health_detail,
    modelCount: row.model_count,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

import { randomUUID } from 'node:crypto';
import {
  CREDENTIAL_REF_PREFIX,
  credentialRecordSchema,
  isCredentialRef,
  type CredentialKind,
  type CredentialRecord,
  type VaultBackend,
} from '@sheep/core';
import type { SqliteDatabase } from './sqlite/types';

export class CredentialRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialRegistryError';
  }
}

/** A fresh, opaque handle. Recognisable in the OS credential store as ours. */
export function newCredentialRef(): string {
  return `${CREDENTIAL_REF_PREFIX}${randomUUID()}`;
}

export interface RegisterCredentialInput {
  readonly label: string;
  readonly vendorId: string;
  readonly kind: CredentialKind;
  readonly backend: VaultBackend;
  /** Supplied only when importing; normally generated. */
  readonly credentialRef?: string;
}

type CredentialRow = {
  credential_ref: string;
  label: string;
  vendor_id: string;
  kind: string;
  backend: string;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
};

const COLUMNS =
  'credential_ref, label, vendor_id, kind, backend, created_at, updated_at, last_verified_at';

/**
 * The book-keeping half of credential storage.
 *
 * This class knows every credential exists and nothing about what any of them
 * are. Secrets live in the OS credential store behind the handles kept here —
 * see `@sheep/core`'s `credential.ts` for why the indirection is the point
 * rather than an inconvenience.
 *
 * Nothing in this file accepts a secret as an argument. That is not an accident
 * of the current API; it is the property that makes "the database contains only
 * a reference" checkable by reading the file rather than by trusting a comment.
 */
export class CredentialRegistry {
  readonly #db: SqliteDatabase;
  readonly #now: () => Date;

  constructor(db: SqliteDatabase, options: { now?: () => Date } = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  /** Records a credential's existence and returns its handle. */
  register(input: RegisterCredentialInput): CredentialRecord {
    const credentialRef = input.credentialRef ?? newCredentialRef();
    if (!isCredentialRef(credentialRef)) {
      throw new CredentialRegistryError(`not a credential reference: ${credentialRef}`);
    }

    const at = this.#now().toISOString();
    const record = credentialRecordSchema.parse({
      credentialRef,
      label: input.label,
      vendorId: input.vendorId,
      kind: input.kind,
      backend: input.backend,
      createdAt: at,
      updatedAt: at,
      lastVerifiedAt: null,
    });

    this.#db.run(`INSERT INTO credentials (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      record.credentialRef,
      record.label,
      record.vendorId,
      record.kind,
      record.backend,
      record.createdAt,
      record.updatedAt,
      record.lastVerifiedAt,
    ]);
    return record;
  }

  get(credentialRef: string): CredentialRecord | undefined {
    const row = this.#db.get<CredentialRow>(
      `SELECT ${COLUMNS} FROM credentials WHERE credential_ref = ?`,
      [credentialRef],
    );
    return row ? toRecord(row) : undefined;
  }

  list(): CredentialRecord[] {
    return this.#db
      .all<CredentialRow>(`SELECT ${COLUMNS} FROM credentials ORDER BY vendor_id, label`)
      .map(toRecord);
  }

  listForVendor(vendorId: string): CredentialRecord[] {
    return this.#db
      .all<CredentialRow>(`SELECT ${COLUMNS} FROM credentials WHERE vendor_id = ? ORDER BY label`, [
        vendorId,
      ])
      .map(toRecord);
  }

  count(): number {
    return this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM credentials')?.n ?? 0;
  }

  rename(credentialRef: string, label: string): boolean {
    return (
      this.#db.run('UPDATE credentials SET label = ?, updated_at = ? WHERE credential_ref = ?', [
        label,
        this.#now().toISOString(),
        credentialRef,
      ]).changes > 0
    );
  }

  /** Records where the secret now lives, e.g. after a fallback. */
  setBackend(credentialRef: string, backend: VaultBackend): boolean {
    return (
      this.#db.run('UPDATE credentials SET backend = ?, updated_at = ? WHERE credential_ref = ?', [
        backend,
        this.#now().toISOString(),
        credentialRef,
      ]).changes > 0
    );
  }

  /** Notes that a live request succeeded with this credential. */
  markVerified(credentialRef: string): boolean {
    const at = this.#now().toISOString();
    return (
      this.#db.run(
        'UPDATE credentials SET last_verified_at = ?, updated_at = ? WHERE credential_ref = ?',
        [at, at, credentialRef],
      ).changes > 0
    );
  }

  /**
   * Forgets the record.
   *
   * Deleting the secret itself is the vault's job, and the caller's
   * responsibility to do as well — an entry left in the OS store with no record
   * here is orphaned rather than dangerous, which is the safer of the two ways
   * to get this wrong.
   */
  remove(credentialRef: string): boolean {
    return (
      this.#db.run('DELETE FROM credentials WHERE credential_ref = ?', [credentialRef]).changes > 0
    );
  }
}

function toRecord(row: CredentialRow): CredentialRecord {
  return {
    credentialRef: row.credential_ref,
    label: row.label,
    vendorId: row.vendor_id,
    kind: row.kind as CredentialKind,
    backend: row.backend as VaultBackend,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at,
  };
}

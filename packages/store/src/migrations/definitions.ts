/**
 * Versioned schema migrations.
 *
 * Rules: versions are contiguous from 1, an applied migration is never edited
 * (its checksum is recorded and re-verified on every open), and every table is
 * STRICT so SQLite enforces column types rather than coercing them.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  /** SQL executed inside a transaction. Its text is checksummed. */
  readonly up: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'app_meta',
    up: `
      CREATE TABLE app_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      INSERT INTO app_meta (key, value)
      VALUES ('schema_initialised_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `,
  },
  {
    version: 2,
    name: 'event_log',
    up: `
      CREATE TABLE events (
        seq          INTEGER PRIMARY KEY,
        event_id     TEXT NOT NULL UNIQUE,
        session_id   TEXT,
        type         TEXT NOT NULL,
        payload      TEXT NOT NULL,
        recorded_at  TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        prev_hash    TEXT NOT NULL,
        entry_hash   TEXT NOT NULL UNIQUE
      ) STRICT;

      CREATE INDEX events_session_seq_idx ON events (session_id, seq);
      CREATE INDEX events_type_seq_idx    ON events (type, seq);
    `,
  },
  {
    version: 3,
    name: 'blob_index',
    up: `
      CREATE TABLE blobs (
        hash       TEXT PRIMARY KEY,
        bytes      INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      -- One row per distinct holder rather than an integer counter: retaining
      -- the same reference twice is then a no-op, which is what makes a
      -- projection replay safe to run over an already-populated index.
      CREATE TABLE blob_refs (
        hash        TEXT NOT NULL REFERENCES blobs(hash) ON DELETE CASCADE,
        ref_kind    TEXT NOT NULL,
        ref_id      TEXT NOT NULL,
        retained_at TEXT NOT NULL,
        PRIMARY KEY (hash, ref_kind, ref_id)
      ) STRICT;

      CREATE INDEX blob_refs_owner_idx ON blob_refs (ref_kind, ref_id);
    `,
  },
  {
    version: 4,
    name: 'projection_state',
    up: `
      -- Bookkeeping for derived tables: how far each projection has replayed,
      -- and which shape it was built with. The projected tables themselves are
      -- created by the projection that owns them, not by a migration — they
      -- hold nothing the event log does not, so they can be dropped and rebuilt
      -- at will, and a shape change is a rebuild rather than a schema upgrade.
      CREATE TABLE projection_state (
        name        TEXT PRIMARY KEY,
        ddl_version INTEGER NOT NULL,
        last_seq    INTEGER NOT NULL,
        updated_at  TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 5,
    name: 'settings_and_credential_refs',
    up: `
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      -- Credentials by reference only. There is no column here a secret could
      -- occupy: what is stored is a handle naming an entry in the operating
      -- system's own credential store, so this file can be copied, backed up or
      -- attached to a bug report without carrying anybody's API key.
      CREATE TABLE credentials (
        credential_ref   TEXT PRIMARY KEY,
        label            TEXT NOT NULL,
        vendor_id        TEXT NOT NULL,
        kind             TEXT NOT NULL,
        backend          TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        last_verified_at TEXT
      ) STRICT;

      CREATE INDEX credentials_vendor_idx ON credentials (vendor_id, label);
    `,
  },
];

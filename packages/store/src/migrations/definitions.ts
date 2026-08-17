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
];

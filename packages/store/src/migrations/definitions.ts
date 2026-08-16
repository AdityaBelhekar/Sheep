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
];

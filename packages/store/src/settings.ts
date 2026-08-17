import {
  SETTING_KEYS,
  defaultSettings,
  parseSetting,
  settingSchemaFor,
  type SettingKey,
  type SettingUpdate,
  type Settings,
} from '@sheep/core';
import { canonicalJson, parseJson } from './events/json';
import type { SqliteDatabase } from './sqlite/types';

/**
 * Persisted application settings.
 *
 * Every key has a default, so `get` always answers and the app is never in an
 * undefined configuration. A stored value that no longer validates — written by
 * an older build, or edited by hand — falls back to the default rather than
 * propagating: a bad preference is not worth failing to start over.
 *
 * `set`, by contrast, validates strictly and throws. The two directions are
 * deliberately asymmetric: be forgiving about what is already on disk, be
 * exacting about what is written to it.
 */
export class SettingsStore {
  readonly #db: SqliteDatabase;
  readonly #now: () => Date;

  constructor(db: SqliteDatabase, options: { now?: () => Date } = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  get<K extends SettingKey>(key: K): Settings[K] {
    const row = this.#db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
    if (!row) return defaultSettings()[key];

    try {
      const parsed = settingSchemaFor(key).safeParse(parseJson(row.value));
      if (parsed.success) return parsed.data as Settings[K];
    } catch {
      // Unparseable text on disk. Same answer as an invalid value.
    }
    return defaultSettings()[key];
  }

  getAll(): Settings {
    const settings = defaultSettings();
    for (const key of SETTING_KEYS) {
      // Assigning through the union needs the write to be keyed the same way it
      // is read; `getAll` is the one place both halves are generic at once.
      Object.assign(settings, { [key]: this.get(key) });
    }
    return settings;
  }

  set<K extends SettingKey>(key: K, value: Settings[K]): Settings[K] {
    const validated = parseSetting(key, value);
    this.#db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, canonicalJson(validated as never), this.#now().toISOString()],
    );
    return validated;
  }

  /**
   * Applies one `{ key, value }` update.
   *
   * The union correlates its key with its value, but TypeScript cannot carry
   * that correlation through a generic call — so the pair is re-checked against
   * the key's own schema inside `set`, which is what actually makes this sound
   * rather than merely accepted.
   */
  apply(update: SettingUpdate): Settings {
    this.set(update.key, update.value as never);
    return this.getAll();
  }

  /** Forgets an explicit value, so the key reverts to its default. */
  reset(key: SettingKey): boolean {
    return this.#db.run('DELETE FROM settings WHERE key = ?', [key]).changes > 0;
  }

  resetAll(): number {
    return this.#db.run('DELETE FROM settings').changes;
  }

  /** Keys with an explicitly stored value, as opposed to a default. */
  stored(): SettingKey[] {
    return this.#db
      .all<{ key: string }>('SELECT key FROM settings ORDER BY key')
      .map((row) => row.key)
      .filter((key): key is SettingKey => (SETTING_KEYS as readonly string[]).includes(key));
  }

  /**
   * Removes rows for keys this build no longer knows.
   *
   * Run on open: a setting dropped in an upgrade should not sit in the file
   * forever, and an unknown key can never be read back anyway.
   */
  pruneUnknown(): string[] {
    const known = new Set<string>(SETTING_KEYS);
    const unknown = this.#db
      .all<{ key: string }>('SELECT key FROM settings')
      .map((row) => row.key)
      .filter((key) => !known.has(key));

    for (const key of unknown) this.#db.run('DELETE FROM settings WHERE key = ?', [key]);
    return unknown.sort();
  }
}

import { z } from 'zod';
import { idSchema, usdSchema } from './primitives';

/**
 * Application settings.
 *
 * Small, closed and typed: an unknown key is rejected rather than stored, and
 * every key has a default, so the app has a defined configuration before the
 * user has expressed any preference. Nothing secret ever lives here — secrets
 * go to the OS keychain and only a `credential_ref` is persisted.
 */

export const THEMES = ['light', 'dark', 'system'] as const;
export const themeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof themeSchema>;

export const settingsSchema = z.strictObject({
  'ui.theme': themeSchema,
  /** Which session to reopen on launch. */
  'ui.lastSessionId': idSchema.nullable(),
  /** Pre-filled cap for a new session, in USD. */
  'budget.defaultCapUsd': usdSchema,
});
export type Settings = z.infer<typeof settingsSchema>;

export type SettingKey = keyof Settings;

export const SETTING_DEFAULTS: Settings = {
  'ui.theme': 'system',
  'ui.lastSessionId': null,
  'budget.defaultCapUsd': 10,
};

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS).sort() as SettingKey[];

const KNOWN_KEYS: ReadonlySet<string> = new Set<string>(SETTING_KEYS);

export function isSettingKey(key: string): key is SettingKey {
  return KNOWN_KEYS.has(key);
}

export function settingSchemaFor<K extends SettingKey>(key: K): (typeof settingsSchema.shape)[K] {
  return settingsSchema.shape[key];
}

export function defaultSettings(): Settings {
  return { ...SETTING_DEFAULTS };
}

/**
 * One key and its value, as a discriminated union.
 *
 * Written out rather than generated so the IPC boundary is typed per key — a
 * theme update cannot carry a number. A test asserts it covers exactly
 * `SETTING_KEYS`, which is what keeps it from drifting from `settingsSchema`.
 */
export const settingUpdateSchema = z.discriminatedUnion('key', [
  z.strictObject({ key: z.literal('ui.theme'), value: themeSchema }),
  z.strictObject({ key: z.literal('ui.lastSessionId'), value: idSchema.nullable() }),
  z.strictObject({ key: z.literal('budget.defaultCapUsd'), value: usdSchema }),
]);
export type SettingUpdate = z.infer<typeof settingUpdateSchema>;

export class SettingError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = 'SettingError';
  }
}

/** Validates one value against its key's schema. Throws for an unknown key. */
export function parseSetting<K extends SettingKey>(key: K, value: unknown): Settings[K] {
  if (!isSettingKey(key)) throw new SettingError(key, `Unknown setting: ${key}`);
  const parsed = settingSchemaFor(key).safeParse(value);
  if (!parsed.success) {
    throw new SettingError(
      key,
      `Invalid value for ${key}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return parsed.data as Settings[K];
}

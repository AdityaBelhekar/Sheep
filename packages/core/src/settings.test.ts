import { describe, expect, it } from 'vitest';
import { credentialRefSchema, isCredentialRef } from './credential';
import {
  SETTING_DEFAULTS,
  SETTING_KEYS,
  SettingError,
  defaultSettings,
  isSettingKey,
  parseSetting,
  settingUpdateSchema,
  settingsSchema,
} from './settings';

describe('the settings registry', () => {
  it('has a default for every key, and no key without one', () => {
    expect(Object.keys(SETTING_DEFAULTS).sort()).toEqual(Object.keys(settingsSchema.shape).sort());
    expect(settingsSchema.safeParse(SETTING_DEFAULTS).success).toBe(true);
    expect([...SETTING_KEYS].sort()).toEqual(Object.keys(SETTING_DEFAULTS).sort());
  });

  it('hands out a copy, so a caller cannot mutate the defaults', () => {
    const first = defaultSettings();
    first['ui.theme'] = 'dark';
    expect(defaultSettings()['ui.theme']).toBe('system');
    expect(SETTING_DEFAULTS['ui.theme']).toBe('system');
  });

  it('recognises its own keys and rejects anything else', () => {
    for (const key of SETTING_KEYS) expect(isSettingKey(key)).toBe(true);
    for (const key of ['', 'theme', 'ui.Theme', 'ui.theme ', '__proto__']) {
      expect(isSettingKey(key)).toBe(false);
    }
  });

  it('validates a value against its own key', () => {
    expect(parseSetting('ui.theme', 'dark')).toBe('dark');
    expect(parseSetting('budget.defaultCapUsd', 42.5)).toBe(42.5);
    expect(parseSetting('ui.lastSessionId', null)).toBeNull();
  });

  it('refuses a value of the wrong shape for its key', () => {
    expect(() => parseSetting('ui.theme', 'sepia')).toThrow(SettingError);
    expect(() => parseSetting('ui.theme', 1)).toThrow(SettingError);
    expect(() => parseSetting('budget.defaultCapUsd', -1)).toThrow(SettingError);
    expect(() => parseSetting('budget.defaultCapUsd', 'ten')).toThrow(SettingError);
    expect(() => parseSetting('ui.lastSessionId', 'not-a-uuid')).toThrow(SettingError);
  });

  it('rejects an unknown key by name', () => {
    // A caller reaching past the types still cannot invent a setting.
    expect(() => parseSetting('ui.wallpaper' as 'ui.theme', 'dark')).toThrow(SettingError);
  });

  it('rejects an unknown key in a whole-record parse', () => {
    expect(settingsSchema.safeParse({ ...SETTING_DEFAULTS, 'ui.wallpaper': 'x' }).success).toBe(
      false,
    );
  });
});

describe('the settings update union', () => {
  it('covers exactly the known keys, so it cannot drift from the record schema', () => {
    const covered = settingUpdateSchema.options.map((option) => option.shape.key.value);
    expect([...covered].sort()).toEqual([...SETTING_KEYS].sort());
  });

  it('types each value against its own key', () => {
    expect(settingUpdateSchema.safeParse({ key: 'ui.theme', value: 'light' }).success).toBe(true);
    expect(settingUpdateSchema.safeParse({ key: 'ui.theme', value: 12 }).success).toBe(false);
    expect(
      settingUpdateSchema.safeParse({ key: 'budget.defaultCapUsd', value: 'lots' }).success,
    ).toBe(false);
    expect(settingUpdateSchema.safeParse({ key: 'nope', value: 1 }).success).toBe(false);
  });
});

describe('credential references', () => {
  it('accepts a prefixed uuid handle and nothing else', () => {
    expect(isCredentialRef('sheep.credential.11111111-1111-4111-8111-111111111111')).toBe(true);
    for (const bad of [
      '11111111-1111-4111-8111-111111111111',
      'sheep.credential.not-a-uuid',
      'sheep.credential.',
      'other.credential.11111111-1111-4111-8111-111111111111',
      'sk-ant-api03-a-real-secret',
      '',
    ]) {
      expect(isCredentialRef(bad), bad).toBe(false);
    }
  });

  it('is a shape a secret cannot masquerade as', () => {
    // The point of the pattern: an API key can never satisfy it, so a column
    // typed as a credential_ref cannot be holding one.
    expect(credentialRefSchema.safeParse('sk-ant-api03-AbCdEfGh1234567890').success).toBe(false);
  });
});

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTING_DEFAULTS, SettingError, defaultSettings } from '@sheep/core';
import { describe, expect, it } from 'vitest';
import { CredentialRegistry, CredentialRegistryError, newCredentialRef } from './credentials';
import { SettingsStore } from './settings';
import { openSheepStore, type SheepStore } from './store';
import { TESTABLE_DRIVERS, useTempDir } from './test-support';
import type { SqliteDriverName } from './sqlite/types';

const tempDir = useTempDir('sheep-settings-');

let counter = 0;

function openStore(driver: SqliteDriverName): SheepStore {
  counter += 1;
  const dir = join(tempDir(), `run-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  return openSheepStore({ dataDir: dir, driver });
}

describe.each(TESTABLE_DRIVERS)('SettingsStore on %s', (driver) => {
  it('answers with defaults before anything has been set', () => {
    const store = openStore(driver);
    try {
      expect(store.settings.getAll()).toEqual(defaultSettings());
      expect(store.settings.get('ui.theme')).toBe('system');
      expect(store.settings.stored()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('persists a value across reopening', () => {
    const store = openStore(driver);
    const dir = store.dataDir;
    try {
      store.settings.set('ui.theme', 'dark');
      store.settings.set('budget.defaultCapUsd', 42.5);
      expect(store.settings.stored().sort()).toEqual(['budget.defaultCapUsd', 'ui.theme']);
    } finally {
      store.close();
    }

    const reopened = openSheepStore({ dataDir: dir, driver });
    try {
      expect(reopened.settings.get('ui.theme')).toBe('dark');
      expect(reopened.settings.get('budget.defaultCapUsd')).toBe(42.5);
      expect(reopened.settings.get('ui.lastSessionId')).toBeNull();
    } finally {
      reopened.close();
    }
  });

  it('refuses to write a value its key does not allow', () => {
    const store = openStore(driver);
    try {
      expect(() => {
        store.settings.set('ui.theme', 'sepia' as 'dark');
      }).toThrow(SettingError);
      // Nothing was stored, so the key still answers with its default.
      expect(store.settings.get('ui.theme')).toBe('system');
      expect(store.settings.stored()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('falls back to the default when what is on disk no longer validates', () => {
    const store = openStore(driver);
    try {
      store.settings.set('ui.theme', 'dark');
      // A value an older build wrote, or a hand edit.
      store.db.run('UPDATE settings SET value = ? WHERE key = ?', ['"sepia"', 'ui.theme']);
      expect(store.settings.get('ui.theme')).toBe('system');

      store.db.run('UPDATE settings SET value = ? WHERE key = ?', ['not json at all', 'ui.theme']);
      expect(store.settings.get('ui.theme')).toBe('system');
      // Still reports the whole record, rather than failing on one bad key.
      expect(store.settings.getAll()).toEqual(defaultSettings());
    } finally {
      store.close();
    }
  });

  it('reverts a key to its default on reset', () => {
    const store = openStore(driver);
    try {
      store.settings.set('ui.theme', 'light');
      expect(store.settings.reset('ui.theme')).toBe(true);
      expect(store.settings.reset('ui.theme')).toBe(false);
      expect(store.settings.get('ui.theme')).toBe('system');

      store.settings.set('ui.theme', 'dark');
      store.settings.set('budget.defaultCapUsd', 1);
      expect(store.settings.resetAll()).toBe(2);
      expect(store.settings.getAll()).toEqual(SETTING_DEFAULTS);
    } finally {
      store.close();
    }
  });

  it('applies a keyed update object', () => {
    const store = openStore(driver);
    try {
      const after = store.settings.apply({ key: 'ui.theme', value: 'light' });
      expect(after['ui.theme']).toBe('light');
      expect(store.settings.get('ui.theme')).toBe('light');
    } finally {
      store.close();
    }
  });

  it('drops keys this build no longer knows, on open', () => {
    const store = openStore(driver);
    const dir = store.dataDir;
    try {
      store.settings.set('ui.theme', 'dark');
      store.db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [
        'ui.retiredOption',
        '"whatever"',
        '2026-01-01T00:00:00.000Z',
      ]);
      expect(store.settings.pruneUnknown()).toEqual(['ui.retiredOption']);
      expect(store.settings.pruneUnknown()).toEqual([]);
      expect(store.settings.get('ui.theme')).toBe('dark');
    } finally {
      store.close();
    }

    const reopened = openSheepStore({ dataDir: dir, driver });
    try {
      expect(reopened.settings.stored()).toEqual(['ui.theme']);
    } finally {
      reopened.close();
    }
  });

  it('is usable directly against a database, without the whole store', () => {
    const store = openStore(driver);
    try {
      const settings = new SettingsStore(store.db, {
        now: () => new Date('2026-08-17T09:00:00.000Z'),
      });
      settings.set('ui.theme', 'dark');
      expect(
        store.db.get<{ updated_at: string }>('SELECT updated_at FROM settings WHERE key = ?', [
          'ui.theme',
        ])?.updated_at,
      ).toBe('2026-08-17T09:00:00.000Z');
    } finally {
      store.close();
    }
  });
});

const SECRET = 'sk-ant-api03-ThisIsAFakeButRealisticLookingApiKey0123456789';

describe.each(TESTABLE_DRIVERS)('CredentialRegistry on %s', (driver) => {
  it('records a credential by reference and nothing more', () => {
    const store = openStore(driver);
    try {
      const record = store.credentials.register({
        label: 'Anthropic (personal)',
        vendorId: 'anthropic',
        kind: 'api-key',
        backend: 'os-keychain',
      });

      expect(record.credentialRef).toMatch(/^sheep\.credential\.[0-9a-f-]{36}$/);
      expect(record.lastVerifiedAt).toBeNull();
      expect(store.credentials.get(record.credentialRef)).toEqual(record);
      expect(store.credentials.count()).toBe(1);

      // Every column of the table, checked for anything secret-shaped.
      const row = store.db.get('SELECT * FROM credentials');
      expect(Object.keys(row ?? {}).sort()).toEqual([
        'backend',
        'created_at',
        'credential_ref',
        'kind',
        'label',
        'last_verified_at',
        'updated_at',
        'vendor_id',
      ]);
    } finally {
      store.close();
    }
  });

  it('has no way to be handed a secret in the first place', () => {
    const store = openStore(driver);
    try {
      // The registry's whole surface is checked here: if any of these ever
      // accepted a secret, this list is where it would have to appear.
      const surface = Object.getOwnPropertyNames(CredentialRegistry.prototype).sort();
      expect(surface).toEqual([
        'constructor',
        'count',
        'get',
        'list',
        'listForVendor',
        'markVerified',
        'register',
        'remove',
        'rename',
        'setBackend',
      ]);
    } finally {
      store.close();
    }
  });

  // A scan for absence proves nothing unless the scan is known to be capable of
  // finding the thing. This is the positive control for the test that follows.
  it('detects a secret written into the database file', () => {
    const store = openStore(driver);
    const path = store.path;
    try {
      store.db.exec('CREATE TABLE leaky (value TEXT NOT NULL) STRICT');
      store.db.run('INSERT INTO leaky (value) VALUES (?)', [SECRET]);
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      store.close();
    }
    expect(databaseFilesContain(path, SECRET)).toBe(true);
  });

  it('leaves no trace of a secret in the database file when a credential is saved', () => {
    const store = openStore(driver);
    const path = store.path;
    try {
      // The real flow, with a Map standing in for the OS credential store: the
      // secret goes to the vault, and only the handle it was filed under is
      // ever handed to the database.
      const vault = new Map<string, string>();
      const credentialRef = newCredentialRef();
      vault.set(credentialRef, SECRET);

      store.credentials.register({
        label: 'Anthropic (personal)',
        vendorId: 'anthropic',
        kind: 'api-key',
        backend: 'os-keychain',
        credentialRef,
      });
      store.settings.set('ui.theme', 'dark');
      store.credentials.markVerified(credentialRef);

      // The secret really does exist in this process, and really is retrievable
      // by its handle — so its absence from the file below is a fact about the
      // registry rather than about the test never having had a secret.
      expect(vault.get(credentialRef)).toBe(SECRET);
      expect(store.credentials.get(credentialRef)?.lastVerifiedAt).not.toBeNull();

      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      store.close();
    }

    expect(databaseFilesContain(path, SECRET)).toBe(false);
  });

  it('rejects a handle that is not a credential reference', () => {
    const store = openStore(driver);
    try {
      expect(() => {
        store.credentials.register({
          label: 'Smuggled',
          vendorId: 'anthropic',
          kind: 'api-key',
          backend: 'os-keychain',
          // The obvious mistake this guard exists to catch.
          credentialRef: SECRET,
        });
      }).toThrow(CredentialRegistryError);
      expect(store.credentials.count()).toBe(0);
    } finally {
      store.close();
    }
  });

  it('lists by vendor, renames, retargets and removes', () => {
    const store = openStore(driver);
    try {
      const a = store.credentials.register({
        label: 'Anthropic (work)',
        vendorId: 'anthropic',
        kind: 'api-key',
        backend: 'os-keychain',
      });
      store.credentials.register({
        label: 'OpenAI',
        vendorId: 'openai',
        kind: 'api-key',
        backend: 'os-keychain',
      });

      expect(store.credentials.listForVendor('anthropic')).toHaveLength(1);
      expect(store.credentials.list().map((record) => record.vendorId)).toEqual([
        'anthropic',
        'openai',
      ]);

      expect(store.credentials.rename(a.credentialRef, 'Anthropic (personal)')).toBe(true);
      expect(store.credentials.get(a.credentialRef)?.label).toBe('Anthropic (personal)');

      expect(store.credentials.setBackend(a.credentialRef, 'encrypted-file')).toBe(true);
      expect(store.credentials.get(a.credentialRef)?.backend).toBe('encrypted-file');

      expect(store.credentials.remove(a.credentialRef)).toBe(true);
      expect(store.credentials.remove(a.credentialRef)).toBe(false);
      expect(store.credentials.count()).toBe(1);
    } finally {
      store.close();
    }
  });

  it('refuses two credentials under one handle', () => {
    const store = openStore(driver);
    try {
      const credentialRef = newCredentialRef();
      const input = {
        label: 'First',
        vendorId: 'anthropic',
        kind: 'api-key' as const,
        backend: 'os-keychain' as const,
        credentialRef,
      };
      store.credentials.register(input);
      expect(() => store.credentials.register(input)).toThrow();
    } finally {
      store.close();
    }
  });

  it('reports nothing for a handle it has never seen', () => {
    const store = openStore(driver);
    try {
      expect(store.credentials.get(newCredentialRef())).toBeUndefined();
      expect(store.credentials.markVerified(newCredentialRef())).toBe(false);
      expect(store.credentials.rename(newCredentialRef(), 'x')).toBe(false);
    } finally {
      store.close();
    }
  });
});

/** True when the database, its WAL or its shared-memory file holds `needle`. */
function databaseFilesContain(databasePath: string, needle: string): boolean {
  const bytes = Buffer.from(needle, 'utf8');
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .filter((file) => existsSync(file))
    .some((file) => readFileSync(file).includes(bytes));
}

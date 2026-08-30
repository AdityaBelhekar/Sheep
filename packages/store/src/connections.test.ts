import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConnectionRegistryError, newAdapterId } from './connections';
import { openSheepStore, type SheepStore } from './store';
import { TESTABLE_DRIVERS, useTempDir } from './test-support';
import type { SqliteDriverName } from './sqlite/types';

const tempDir = useTempDir('sheep-connections-');

let counter = 0;

function openStore(driver: SqliteDriverName): SheepStore {
  counter += 1;
  const dir = join(tempDir(), `run-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  return openSheepStore({ dataDir: dir, driver });
}

describe.each(TESTABLE_DRIVERS)('ConnectionRegistry on %s', (driver) => {
  it('stores a connection and derives its vendor from the config', () => {
    const store = openStore(driver);
    try {
      const connection = store.connections.add({
        label: 'Groq (work)',
        config: { kind: 'openai-compatible', preset: 'groq' },
        credentialRef: null,
      });

      expect(connection.vendorId).toBe('groq');
      expect(connection.adapterId.startsWith('groq-')).toBe(true);
      expect(connection.enabled).toBe(true);
      expect(connection.health).toBe('unknown');
      expect(store.connections.get(connection.connectionId)).toEqual(connection);
    } finally {
      store.close();
    }
  });

  it('lets the same provider be configured twice', () => {
    const store = openStore(driver);
    try {
      const work = store.connections.add({ label: 'Work', config: { kind: 'anthropic' } });
      const home = store.connections.add({ label: 'Home', config: { kind: 'anthropic' } });

      expect(work.adapterId).not.toBe(home.adapterId);
      expect(store.connections.count()).toBe(2);
      expect(store.connections.getByAdapterId(home.adapterId)?.label).toBe('Home');
    } finally {
      store.close();
    }
  });

  it('recomputes the vendor when the config changes', () => {
    const store = openStore(driver);
    try {
      const created = store.connections.add({
        label: 'Anything',
        config: { kind: 'openai-compatible', preset: 'together' },
      });
      const updated = store.connections.update(created.connectionId, {
        config: { kind: 'openai-compatible', preset: 'deepseek' },
      });

      expect(updated.vendorId).toBe('deepseek');
      // The registry key survives an edit, or a live adapter would be orphaned.
      expect(updated.adapterId).toBe(created.adapterId);
    } finally {
      store.close();
    }
  });

  it('throws away a health verdict recorded against the old settings', () => {
    const store = openStore(driver);
    try {
      const created = store.connections.add({
        label: 'Local',
        config: { kind: 'local', provider: 'ollama' },
      });
      store.connections.recordCheck(created.connectionId, {
        health: 'ok',
        detail: '3 models reachable',
        modelCount: 3,
        checkedAt: '2026-08-30T10:00:00.000Z',
      });
      expect(store.connections.get(created.connectionId)?.health).toBe('ok');

      const updated = store.connections.update(created.connectionId, {
        config: { kind: 'local', provider: 'lmstudio' },
      });

      expect(updated.health).toBe('unknown');
      expect(updated.healthDetail).toBeNull();
      expect(updated.modelCount).toBeNull();
      expect(updated.checkedAt).toBeNull();
    } finally {
      store.close();
    }
  });

  it('keeps the credential reference through an unrelated edit', () => {
    const store = openStore(driver);
    try {
      const ref = 'sheep.credential.2f9f1c1e-6a3f-4c7a-9f0b-8f5b0b0f1a2b';
      const created = store.connections.add({
        label: 'Anthropic',
        config: { kind: 'anthropic' },
        credentialRef: ref,
      });

      expect(
        store.connections.update(created.connectionId, { label: 'Renamed' }).credentialRef,
      ).toBe(ref);
    } finally {
      store.close();
    }
  });

  it('lists only the enabled connections when asked for those', () => {
    const store = openStore(driver);
    try {
      const on = store.connections.add({ label: 'On', config: { kind: 'anthropic' } });
      const off = store.connections.add({ label: 'Off', config: { kind: 'google' } });
      store.connections.update(off.connectionId, { enabled: false });

      expect(store.connections.listEnabled().map((c) => c.connectionId)).toEqual([on.connectionId]);
      expect(store.connections.list()).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it('survives a reopen, config and all', () => {
    const store = openStore(driver);
    const dir = store.dataDir;
    let connectionId: string;
    try {
      connectionId = store.connections.add({
        label: 'Azure',
        config: {
          kind: 'azure-openai',
          endpoint: 'https://sheep.openai.azure.com',
          apiVersion: '2024-10-21',
        },
      }).connectionId;
    } finally {
      store.close();
    }

    const reopened = openSheepStore({ dataDir: dir, driver });
    try {
      const connection = reopened.connections.get(connectionId);
      expect(connection?.config).toEqual({
        kind: 'azure-openai',
        endpoint: 'https://sheep.openai.azure.com',
        apiVersion: '2024-10-21',
      });
      expect(connection?.vendorId).toBe('openai');
    } finally {
      reopened.close();
    }
  });

  it('refuses to update something that is not there', () => {
    const store = openStore(driver);
    try {
      expect(() =>
        store.connections.update('2f9f1c1e-6a3f-4c7a-9f0b-8f5b0b0f1a2b', { label: 'Nope' }),
      ).toThrow(ConnectionRegistryError);
    } finally {
      store.close();
    }
  });

  it('removes a connection and reports whether there was one', () => {
    const store = openStore(driver);
    try {
      const created = store.connections.add({ label: 'Temp', config: { kind: 'anthropic' } });
      expect(store.connections.remove(created.connectionId)).toBe(true);
      expect(store.connections.remove(created.connectionId)).toBe(false);
      expect(store.connections.count()).toBe(0);
    } finally {
      store.close();
    }
  });

  /**
   * The same property the credential registry has, checked the same way: by
   * reading the file rather than by trusting the API's shape.
   */
  it('writes no secret into the database file', () => {
    const store = openStore(driver);
    try {
      store.connections.add({
        label: 'Anthropic',
        config: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com' },
        credentialRef: 'sheep.credential.2f9f1c1e-6a3f-4c7a-9f0b-8f5b0b0f1a2b',
      });
      const bytes = readFileSync(store.path);
      expect(bytes.includes(Buffer.from('sk-ant-', 'utf8'))).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe('newAdapterId', () => {
  it('is a slug, so it can be an adapter registry key', () => {
    for (const config of [
      { kind: 'anthropic' },
      { kind: 'openai-compatible', preset: 'openrouter' },
      { kind: 'azure-openai', endpoint: 'https://x.test', apiVersion: '2024-10-21' },
      { kind: 'local', provider: 'llamacpp' },
    ] as const) {
      expect(newAdapterId(config)).toMatch(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/);
    }
  });

  it('does not collide across two calls for the same provider', () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => newAdapterId({ kind: 'anthropic' } as const)),
    );
    expect(ids.size).toBe(50);
  });
});

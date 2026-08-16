import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { isBetterSqliteAvailable } from './sqlite/better-sqlite3-driver';
import type { SqliteDriverName } from './sqlite/types';

/**
 * Drivers to exercise in tests. The WebAssembly build is always present; the
 * native one is only tested when this machine actually has a usable build, so
 * the suite proves parity wherever parity is possible.
 */
export const TESTABLE_DRIVERS: SqliteDriverName[] = [
  ...(isBetterSqliteAvailable() ? (['better-sqlite3'] as const) : []),
  'node-sqlite3-wasm',
];

/** A fresh temp directory per test, removed afterwards. */
export function useTempDir(prefix = 'sheep-'): () => string {
  let directory: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), prefix));
  });

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  return () => {
    if (!directory) throw new Error('useTempDir() may only be called inside a test');
    return directory;
  };
}

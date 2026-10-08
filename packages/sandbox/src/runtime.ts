import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import lock from '../runtime.lock.json';

/**
 * The bundled interpreter, as the lock file pins it.
 *
 * `scripts/fetch-runtime.mjs` installs it and stamps the directory with the
 * hash of the lock entry it installed from. A runtime whose stamp does not
 * match the lock this build carries is refused rather than used: a run that
 * records one environment hash and executes on another is not reproducible,
 * it only looks it.
 */
export interface PythonRuntime {
  readonly dir: string;
  /** Absolute path to the interpreter. */
  readonly python: string;
  readonly version: string;
  /** Identifies interpreter + wheels. Recorded with every execution. */
  readonly lockHash: string;
}

export class RuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(`${message}; run \`npm run fetch-runtime\``);
    this.name = 'RuntimeUnavailableError';
  }
}

const MARKER = 'sheep-runtime.json';

type LockEntry = (typeof lock)['win32-x64'];

function lockEntry(): LockEntry {
  const key = `${process.platform}-${process.arch}`;
  const entry = (lock as Record<string, LockEntry | undefined>)[key];
  if (!entry) throw new RuntimeUnavailableError(`no python runtime is pinned for ${key}`);
  return entry;
}

/** Must match `lockHashOf` in scripts/fetch-runtime.mjs. */
export function expectedLockHash(): string {
  return createHash('sha256').update(JSON.stringify(lockEntry())).digest('hex');
}

/** The packages a run may import, with the versions the lock pins. */
export function lockedPackages(): { name: string; version: string }[] {
  return lockEntry().wheels.map(({ name, version }) => ({ name, version }));
}

/** Where the fetch script puts the runtime in a source checkout. */
export function devRuntimeDir(): string {
  return join(import.meta.dirname, '..', 'runtime');
}

export function locateRuntime(dir: string): PythonRuntime {
  const entry = lockEntry();
  const python =
    process.platform === 'win32' ? join(dir, 'python.exe') : join(dir, 'bin', 'python3');
  const markerPath = join(dir, MARKER);
  if (!existsSync(python) || !existsSync(markerPath)) {
    throw new RuntimeUnavailableError(`the python runtime is not installed at ${dir}`);
  }

  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { lockHash?: string };
  const lockHash = expectedLockHash();
  if (marker.lockHash !== lockHash) {
    throw new RuntimeUnavailableError(
      `the python runtime at ${dir} was installed from a different lock`,
    );
  }
  return { dir, python, version: entry.python.version, lockHash };
}

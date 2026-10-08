import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  devRuntimeDir,
  expectedLockHash,
  locateRuntime,
  lockedPackages,
  RuntimeUnavailableError,
} from './runtime';

describe('bundled python runtime', () => {
  // No skip when the runtime is absent: a sandbox suite that quietly does not
  // run is worse than one that fails and says how to fix it.
  it('is installed from the lock this build carries', () => {
    const runtime = locateRuntime(devRuntimeDir());
    expect(runtime.lockHash).toBe(expectedLockHash());
    expect(runtime.version).toMatch(/^3\.12\./);
  });

  it('runs the pinned interpreter with every locked package at its locked version', () => {
    const runtime = locateRuntime(devRuntimeDir());
    const script = [
      'import json, sys',
      'from importlib.metadata import version',
      'names = json.loads(sys.argv[1])',
      'print(json.dumps([sys.version.split()[0], {n: version(n) for n in names}]))',
    ].join('\n');
    const locked = lockedPackages();
    const out = execFileSync(
      runtime.python,
      ['-I', '-c', script, JSON.stringify(locked.map((p) => p.name))],
      { encoding: 'utf8' },
    );
    const [version, installed] = JSON.parse(out) as [string, Record<string, string>];

    expect(version).toBe(runtime.version);
    expect(installed).toEqual(Object.fromEntries(locked.map((p) => [p.name, p.version])));
    for (const required of ['numpy', 'scipy', 'sympy', 'pandas', 'matplotlib', 'scikit-learn']) {
      expect(installed).toHaveProperty(required);
    }
  }, 60_000);

  it('refuses a directory with no runtime, and one stamped by another lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sheep-runtime-test-'));
    try {
      expect(() => locateRuntime(dir)).toThrow(RuntimeUnavailableError);

      writeFileSync(join(dir, 'python.exe'), '');
      writeFileSync(join(dir, 'sheep-runtime.json'), JSON.stringify({ lockHash: 'f'.repeat(64) }));
      expect(() => locateRuntime(dir)).toThrow(/different lock/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, vi } from 'vitest';
import { devRuntimeDir, locateRuntime } from './runtime';
import { Sandbox } from './sandbox';

/** A sandbox on the real runtime, rooted in a directory the suite removes. */
export function testSandbox(): { sandbox: Sandbox; root: string } {
  // Every test here starts real processes, on a machine that may be busy.
  vi.setConfig({ testTimeout: 30_000 });
  const root = mkdtempSync(join(tmpdir(), 'sheep-sandbox-test-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return { sandbox: new Sandbox({ runtime: locateRuntime(devRuntimeDir()), root }), root };
}

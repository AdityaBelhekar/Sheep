import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { devRuntimeDir, locateRuntime } from './runtime';
import { Sandbox } from './sandbox';

/** A sandbox on the real runtime, rooted in a directory the suite removes. */
export function testSandbox(): { sandbox: Sandbox; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'sheep-sandbox-test-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return { sandbox: new Sandbox({ runtime: locateRuntime(devRuntimeDir()), root }), root };
}

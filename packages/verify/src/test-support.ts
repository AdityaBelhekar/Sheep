import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, vi } from 'vitest';
import type { Derivation, DerivationStep } from '@sheep/core';
import { devRuntimeDir, locateRuntime, Sandbox } from '@sheep/sandbox';
import { Verifier } from './verifier';

/** A verifier on the real runtime, in a sandbox the suite removes. */
export function testVerifier(options?: { timeoutMs?: number }): Verifier {
  // Every check starts a real interpreter and imports SymPy.
  vi.setConfig({ testTimeout: 120_000 });
  const root = mkdtempSync(join(tmpdir(), 'sheep-verify-test-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return new Verifier(new Sandbox({ runtime: locateRuntime(devRuntimeDir()), root }), options);
}

type StepInput = Omit<DerivationStep, 'id'> & { id?: string };

/** A derivation with ids filled in: premises g1.., steps s1... */
export function derivation(
  given: readonly string[],
  steps: readonly StepInput[],
  symbols?: Derivation['symbols'],
): Derivation {
  return {
    ...(symbols ? { symbols } : {}),
    given: given.map((statement, index) => ({ id: `g${String(index + 1)}`, statement })),
    steps: steps.map((step, index) => ({ id: `s${String(index + 1)}`, ...step })),
  };
}

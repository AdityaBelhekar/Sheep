import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { devRuntimeDir, locateRuntime, Sandbox } from '@sheep/sandbox';
import { matplotlibScript } from './matplotlib';

// Every test here starts a real interpreter and imports matplotlib.
vi.setConfig({ testTimeout: 120_000 });

const root = mkdtempSync(join(tmpdir(), 'sheep-figure-test-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
const sandbox = new Sandbox({ runtime: locateRuntime(devRuntimeDir()), root });

const PLOT = `
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng()
fig, ax = plt.subplots()
ax.plot(np.cumsum(rng.normal(size=100)))
ax.set_title("Random walk")

plt.figure()
plt.hist(rng.normal(size=500), bins=20)
`;

describe('matplotlib figures', () => {
  it('keeps every figure the script drew, for screen and print', async () => {
    const run = await sandbox.run({ code: matplotlibScript(PLOT), seed: 3 });
    try {
      expect(run.status, run.stderr).toBe('ok');
      expect(run.artifacts.map((artifact) => artifact.path)).toEqual([
        'figure-1.pdf',
        'figure-1.svg',
        'figure-2.pdf',
        'figure-2.svg',
      ]);
    } finally {
      run.dispose();
    }
  });

  it('draws the same bytes from the same script and seed', async () => {
    const code = matplotlibScript(PLOT);
    const first = await sandbox.run({ code, seed: 3 });
    const second = await sandbox.run({ code, seed: 3 });
    first.dispose();
    second.dispose();

    expect(second.artifacts).toEqual(first.artifacts);
    expect(second.codeHash).toBe(first.codeHash);
  });

  it('leaves a script that draws nothing with nothing', async () => {
    const run = await sandbox.run({ code: matplotlibScript('print("no plot")') });
    run.dispose();
    expect(run.status, run.stderr).toBe('ok');
    expect(run.artifacts).toEqual([]);
  });
});

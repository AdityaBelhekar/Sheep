import { describe, expect, it } from 'vitest';
import { expectedLockHash } from './runtime';
import { SandboxLimitError } from './sandbox';
import { testSandbox } from './test-support';

const { sandbox } = testSandbox();

/**
 * Everything here that could differ between two starts of an interpreter does,
 * unless something pins it: str hashing, three random generators, and three
 * figure formats that each stamp or salt their output.
 */
const FIGURES = `
import random
import numpy as np
import matplotlib.pyplot as plt

print(list({"alpha", "beta", "gamma", "delta", "epsilon"}))
print(random.random(), np.random.rand(), np.random.default_rng().random())

rng = np.random.default_rng()
fig, ax = plt.subplots()
ax.plot(np.cumsum(rng.normal(size=200)), label="walk")
ax.scatter(np.random.rand(30) * 200, np.random.rand(30), c=np.random.rand(30))
ax.set_title("Determinism")
ax.legend()
for extension in ("png", "svg", "pdf"):
    fig.savefig(f"figure.{extension}")
`;

describe('deterministic execution', () => {
  it('produces byte-identical figures when the same script runs twice', async () => {
    const first = await sandbox.run({ code: FIGURES, seed: 7 });
    const second = await sandbox.run({ code: FIGURES, seed: 7 });

    expect(first.status, first.stderr).toBe('ok');
    expect(first.artifacts.map((artifact) => artifact.path)).toEqual([
      'figure.pdf',
      'figure.png',
      'figure.svg',
    ]);
    expect(second.artifacts).toEqual(first.artifacts);
    expect(second.stdout).toBe(first.stdout);

    // And the seed is what did it: another seed is another run.
    const other = await sandbox.run({ code: FIGURES, seed: 8 });
    expect(other.stdout).not.toBe(first.stdout);
    expect(other.artifacts.map((artifact) => artifact.sha256)).not.toEqual(
      first.artifacts.map((artifact) => artifact.sha256),
    );
    // First run in a fresh sandbox builds matplotlib's font cache.
  }, 180_000);

  it('leaves a seed the script chose itself alone', async () => {
    const code = 'import numpy as np\nprint(np.random.default_rng(123).random())';
    const [a, b] = await Promise.all([
      sandbox.run({ code, seed: 1 }),
      sandbox.run({ code, seed: 2 }),
    ]);

    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).not.toBe('');
  });

  it('pins the clock zone, the build timestamp and the plotting backend', async () => {
    const result = await sandbox.run({
      code: [
        'import os, sys, time, matplotlib',
        'print(time.timezone, os.environ["SOURCE_DATE_EPOCH"], matplotlib.get_backend())',
        'print(sys.flags.hash_randomization, os.environ["PYTHONHASHSEED"], os.environ["SHEEP_SEED"])',
      ].join('\n'),
      seed: 42,
    });

    expect(result.stdout).toBe('0 946684800 Agg\n1 42 42\n');
  }, 60_000);

  it('records the seed and the environment lock with the run', async () => {
    const result = await sandbox.run({ code: '' });

    expect(result.seed).toBe(0);
    expect(result.envLockHash).toBe(expectedLockHash());
  });

  it('refuses a seed the interpreter would not accept', async () => {
    await expect(sandbox.run({ code: '', seed: -1 })).rejects.toThrow(SandboxLimitError);
    await expect(sandbox.run({ code: '', seed: 2 ** 32 })).rejects.toThrow(/seed/);
  });
});

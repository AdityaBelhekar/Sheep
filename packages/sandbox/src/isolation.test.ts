import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxLimitError } from './sandbox';
import { testSandbox } from './test-support';

const { sandbox } = testSandbox();

describe('job object isolation', () => {
  it('kills a run at its wall-clock limit', async () => {
    const result = await sandbox.run({
      code: 'print("spinning", flush=True)\nwhile True: pass',
      limits: { timeoutMs: 1_500 },
    });

    expect(result).toMatchObject({ status: 'timeout', exitCode: -1, stdout: 'spinning\n' });
    expect(result.durationMs).toBeGreaterThanOrEqual(1_400);
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it('refuses memory past the cap', async () => {
    const result = await sandbox.run({
      code: 'block = bytearray(512 * 1024 * 1024)\nprint("allocated")',
      limits: { memoryMb: 128 },
    });

    expect(result.status).toBe('error');
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('MemoryError');
    expect(result.peakMemoryBytes).toBeLessThanOrEqual(128 * 1024 * 1024);
  });

  it('allows memory under the cap, and reports the peak', async () => {
    const result = await sandbox.run({
      code: 'block = bytearray(64 * 1024 * 1024)\nprint(len(block))',
      limits: { memoryMb: 256 },
    });

    expect(result).toMatchObject({ status: 'ok', stdout: `${String(64 * 1024 * 1024)}\n` });
    expect(result.peakMemoryBytes).toBeGreaterThan(64 * 1024 * 1024);
  });

  it('holds a busy loop to its CPU share', async () => {
    // One spinning thread would otherwise take a whole core. Capped at 1% of
    // the machine, it gets a small fraction of the wall time it ran for.
    const result = await sandbox.run({
      code: [
        'import os, time',
        'start = time.perf_counter()',
        'while time.perf_counter() - start < 2: pass',
        'print(time.process_time() / (time.perf_counter() - start) / os.cpu_count())',
      ].join('\n'),
      limits: { cpuPercent: 1 },
    });

    expect(result.status).toBe('ok');
    // Share of the whole machine actually used; generous, the cap is 0.01.
    expect(Number(result.stdout)).toBeLessThan(0.05);
  });

  it('takes the whole process tree down when the caller aborts', async () => {
    const controller = new AbortController();
    const result = await sandbox.run({
      code: 'import time\nprint("started", flush=True)\ntime.sleep(60)',
      signal: controller.signal,
      onOutput: () => {
        controller.abort();
      },
    });

    expect(result).toMatchObject({ status: 'cancelled', exitCode: -1, stdout: 'started\n' });
    expect(result.durationMs).toBeLessThan(10_000);

    // A script still alive would be holding its working directory open, and
    // Windows would refuse to remove it.
    await expect
      .poll(() => {
        try {
          result.dispose();
        } catch {
          // still dying
        }
        return existsSync(result.workDir);
      })
      .toBe(false);
  });

  it('rejects limits that make no sense before starting anything', async () => {
    await expect(sandbox.run({ code: '', limits: { memoryMb: 1 } })).rejects.toThrow(
      SandboxLimitError,
    );
    await expect(sandbox.run({ code: '', limits: { cpuPercent: 0 } })).rejects.toThrow(
      /cpuPercent/,
    );
    await expect(sandbox.run({ code: '', limits: { timeoutMs: 1.5 } })).rejects.toThrow(
      /timeoutMs/,
    );
  });
});

describe('jailed working directory', () => {
  it('starts the script in its own empty directory', async () => {
    const result = await sandbox.run({
      code: 'import os\nprint(os.getcwd())\nprint(os.listdir())',
    });

    expect(result.stdout).toBe(`${result.workDir}\n['main.py']\n`);
  });

  it('gives each run its own directory', async () => {
    const first = await sandbox.run({ code: 'open("left.txt", "w").write("1")' });
    const second = await sandbox.run({ code: 'import os\nprint(os.listdir())' });

    expect(first.workDir).not.toBe(second.workDir);
    expect(second.stdout).toBe("['main.py']\n");
  });

  it('keeps temporary files inside the jail and out of the artifacts', async () => {
    const result = await sandbox.run({
      code: [
        'import tempfile',
        'handle = tempfile.NamedTemporaryFile(delete=False, suffix=".scratch")',
        'handle.write(b"x")',
        'print(handle.name)',
      ].join('\n'),
    });

    expect(result.status).toBe('ok');
    expect(result.artifacts).toEqual([]);
    expect(dirname(result.stdout.trim())).toBe(join(dirname(result.workDir), 'tmp'));
    expect(readdirSync(join(dirname(result.workDir), 'tmp'))).toHaveLength(1);
  });

  it('refuses a write outside the jail', async () => {
    const target = join(dirname(dirname(dirname(result0.workDir))), '..', 'escaped.txt');
    const result = await sandbox.run({
      code: `open(${JSON.stringify(target)}, "w").write("out")`,
    });

    expect(result.status).toBe('error');
    expect(result.stderr).toContain('PermissionError: sandbox: cannot write outside');
    expect(existsSync(target)).toBe(false);
  });
});

// A finished run, for tests that need to know where the jail is.
const result0 = await sandbox.run({ code: '' });

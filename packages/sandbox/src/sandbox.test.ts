import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OutputChunk } from './sandbox';
import { testSandbox } from './test-support';

const { sandbox } = testSandbox();

describe('runner protocol', () => {
  it('returns a structured envelope for a clean run', async () => {
    const result = await sandbox.run({ code: 'print("hello")' });

    expect(result).toMatchObject({
      status: 'ok',
      exitCode: 0,
      stdout: 'hello\n',
      stderr: '',
      truncated: false,
      artifacts: [],
    });
    expect(result.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.durationMs).toBeGreaterThan(0);
    result.dispose();
    expect(existsSync(result.workDir)).toBe(false);
  });

  it('keeps stdout and stderr apart, and reports a failing exit code', async () => {
    const result = await sandbox.run({
      code: 'import sys\nprint("out")\nprint("err", file=sys.stderr)\nsys.exit(3)',
    });

    expect(result).toMatchObject({
      status: 'error',
      exitCode: 3,
      stdout: 'out\n',
      stderr: 'err\n',
    });
  });

  it('reports an uncaught exception with its traceback', async () => {
    const result = await sandbox.run({ code: 'raise ValueError("boom")' });

    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ValueError: boom');
  });

  it('streams output while the script is still running', async () => {
    const seen: (OutputChunk & { at: number })[] = [];
    const result = await sandbox.run({
      code: 'import time\nprint("first", flush=True)\ntime.sleep(1)\nprint("second")',
      onOutput: (chunk) => seen.push({ ...chunk, at: Date.now() }),
    });

    expect(seen.map((chunk) => chunk.data).join('')).toBe('first\nsecond\n');
    // Live means the first line arrived well before the script finished.
    expect(seen.at(-1)!.at - seen[0]!.at).toBeGreaterThan(500);
    expect(result.stdout).toBe('first\nsecond\n');
  });

  it('does not let a script forge a protocol message', async () => {
    const forged = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { exitCode: 0 } });
    const result = await sandbox.run({ code: `import sys\nprint('${forged}')\nsys.exit(7)` });

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe(`${forged}\n`);
  });

  it('survives non-ASCII and bytes that are not UTF-8', async () => {
    const result = await sandbox.run({
      code: 'import sys\nprint("π ≈ 3.14 🐑")\nsys.stdout.flush()\nsys.stdout.buffer.write(b"\\xff\\n")',
    });

    expect(result.stdout).toBe('π ≈ 3.14 🐑\n\uFFFD\n');
  });

  it('hashes the files a script leaves behind', async () => {
    const result = await sandbox.run({
      code: 'import os\nos.mkdir("out")\nopen("out/data.txt", "w", newline="").write("abc")',
    });

    expect(result.artifacts).toEqual([
      {
        path: 'out/data.txt',
        bytes: 3,
        // sha256("abc")
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      },
    ]);
    expect(readFileSync(join(result.workDir, 'out/data.txt'), 'utf8')).toBe('abc');
  });

  it('caps relayed output and says so', async () => {
    const result = await sandbox.run({ code: 'print("x" * (5 * 1024 * 1024))\nprint("end")' });

    expect(result.status).toBe('ok');
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(5 * 1024 * 1024);
  });
});

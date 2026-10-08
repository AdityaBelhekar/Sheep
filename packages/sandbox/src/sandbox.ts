// The ambient declaration has to travel with this file into other packages' programs.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./raw.d.ts" />
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import guardSource from '../python/guard.py?raw';
import runnerSource from '../python/runner.py?raw';
import type { PythonRuntime } from './runtime';

/**
 * Runs Python in the bundled runtime and reports what happened.
 *
 * One process per run: Node starts the runner, hands it a single JSON-RPC
 * `run` request on stdin, and reads `output` notifications from its stdout
 * until the result arrives. There is no long-lived interpreter to leak state
 * from one run into the next.
 */

export type OutputStream = 'stdout' | 'stderr';

export interface OutputChunk {
  readonly stream: OutputStream;
  readonly data: string;
}

/**
 * - `ok` — the script exited 0.
 * - `error` — the script exited non-zero; `stderr` usually says why.
 * - `cancelled` — the caller aborted it.
 * - `crashed` — the runner itself failed; `detail` says how.
 */
export type RunStatus = 'ok' | 'error' | 'cancelled' | 'crashed';

/** A file the script left in its working directory. */
export interface RunArtifact {
  /** Relative to the working directory, forward slashes. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface RunRequest {
  readonly code: string;
  /** Names the run; generated when absent. */
  readonly executionId?: string;
  readonly signal?: AbortSignal;
  /** Called as the script prints, not after it finishes. */
  readonly onOutput?: (chunk: OutputChunk) => void;
}

export interface RunResult {
  readonly executionId: string;
  readonly status: RunStatus;
  /** The script's own exit code, or -1 when it did not get to exit by itself. */
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when output past the relay cap was dropped. */
  readonly truncated: boolean;
  readonly artifacts: readonly RunArtifact[];
  readonly codeHash: string;
  /** Set when `status` needs explaining beyond the streams. */
  readonly detail?: string;
  /** Where the artifacts are, until `dispose`. */
  readonly workDir: string;
  /** Removes the run's directory. Ingest the artifacts first. */
  dispose(): void;
}

export interface SandboxOptions {
  readonly runtime: PythonRuntime;
  /** A directory the sandbox owns. Created if missing. */
  readonly root: string;
}

const ENTRY = 'main.py';

interface RunnerReply {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly truncated: boolean;
}

type RunnerMessage =
  | { method: 'output'; params: OutputChunk }
  | { id: number; result: RunnerReply }
  | { id: number; error: { message: string } };

export class Sandbox {
  readonly runtime: PythonRuntime;
  readonly #root: string;
  readonly #runner: string;
  readonly #guard: string;

  constructor(options: SandboxOptions) {
    this.runtime = options.runtime;
    this.#root = options.root;

    // Written from the bundle on every start, outside anything a run can
    // write to, so the code that confines a script is never the script's to edit.
    const runnerDir = join(this.#root, 'runner');
    mkdirSync(runnerDir, { recursive: true });
    this.#runner = join(runnerDir, 'runner.py');
    writeFileSync(this.#runner, runnerSource);
    this.#guard = join(runnerDir, 'guard.py');
    writeFileSync(this.#guard, guardSource);
  }

  async run(request: RunRequest): Promise<RunResult> {
    const executionId = request.executionId ?? randomUUID();
    const runDir = join(this.#root, 'runs', executionId);
    const workDir = join(runDir, 'work');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, ENTRY), request.code);

    const outcome = await this.#drive(request, {
      python: this.runtime.python,
      // -s -P: no user site-packages, and no implicit sys.path entry.
      // -B: the runtime is never written to. -X utf8: output decodes one way.
      args: ['-X', 'utf8', '-s', '-P', '-B', this.#guard, ENTRY],
      workDir,
    });

    return {
      executionId,
      ...outcome,
      artifacts: await collectArtifacts(workDir),
      codeHash: createHash('sha256').update(request.code).digest('hex'),
      workDir,
      dispose: () => {
        rmSync(runDir, { recursive: true, force: true });
      },
    };
  }

  #drive(
    request: RunRequest,
    params: Record<string, unknown>,
  ): Promise<
    Pick<
      RunResult,
      'status' | 'exitCode' | 'durationMs' | 'stdout' | 'stderr' | 'truncated' | 'detail'
    >
  > {
    const started = Date.now();
    const child = spawn(this.runtime.python, ['-I', '-S', this.#runner], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const out: Record<OutputStream, string> = { stdout: '', stderr: '' };
    let reply: RunnerReply | undefined;
    let failure: string | undefined;
    let runnerStderr = '';
    let cancelled = false;

    const abort = (): void => {
      cancelled = true;
      child.kill();
    };
    if (request.signal?.aborted) abort();
    request.signal?.addEventListener('abort', abort, { once: true });

    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      runnerStderr += chunk;
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: RunnerMessage;
      try {
        message = JSON.parse(line) as RunnerMessage;
      } catch {
        failure = `the runner sent something that is not JSON: ${line.slice(0, 200)}`;
        return;
      }
      if ('method' in message) {
        out[message.params.stream] += message.params.data;
        request.onOutput?.(message.params);
      } else if ('result' in message) {
        reply = message.result;
      } else {
        failure = message.error.message;
      }
    });

    child.stdin.on('error', () => {
      // The runner died before reading its request; `close` reports it.
    });
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'run', params })}\n`);

    return new Promise((resolve) => {
      child.on('error', (error) => {
        failure = `the runner could not start: ${error.message}`;
      });
      child.on('close', () => {
        request.signal?.removeEventListener('abort', abort);
        const streams = { stdout: out.stdout, stderr: out.stderr };

        if (reply && !cancelled) {
          resolve({
            status: reply.exitCode === 0 ? 'ok' : 'error',
            exitCode: reply.exitCode,
            durationMs: reply.durationMs,
            truncated: reply.truncated,
            ...streams,
          });
          return;
        }
        resolve({
          status: cancelled ? 'cancelled' : 'crashed',
          exitCode: -1,
          durationMs: Date.now() - started,
          truncated: false,
          ...streams,
          ...(cancelled
            ? {}
            : { detail: failure ?? (runnerStderr.trim() || 'the runner exited without a result') }),
        });
      });
    });
  }
}

/**
 * Everything the script left behind, hashed.
 *
 * ponytail: no cap on count or bytes — a script can fill the disk up to the
 * wall clock. Add a quota if a run ever does.
 */
async function collectArtifacts(workDir: string): Promise<RunArtifact[]> {
  const artifacts: RunArtifact[] = [];
  for (const entry of readdirSync(workDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    const path = relative(workDir, absolute).split(sep).join('/');
    if (path === ENTRY) continue;

    const hash = createHash('sha256');
    await pipeline(createReadStream(absolute), hash);
    artifacts.push({ path, bytes: statSync(absolute).size, sha256: hash.digest('hex') });
  }
  return artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

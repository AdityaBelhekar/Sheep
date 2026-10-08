// The ambient declaration has to travel with this file into other packages' programs.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./raw.d.ts" />
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import guardSource from '../python/guard.py?raw';
import runnerSource from '../python/runner.py?raw';
import type { PythonRuntime } from './runtime';

/**
 * Runs Python in the bundled runtime, confined, and reports what happened.
 *
 * One process tree per run: Node starts the runner, hands it a single JSON-RPC
 * `run` request on stdin, and reads `output` notifications from its stdout
 * until the result arrives. There is no long-lived interpreter to leak state
 * from one run into the next.
 *
 * Confinement is layered, and the layers do not trust each other:
 *
 * - a **Job Object** caps memory, CPU share and process count, and kills the
 *   whole tree when the runner goes away for any reason;
 * - a **wall clock** in the runner, backed by one here in case the runner is
 *   the thing that hung;
 * - a **low integrity level**, so the OS itself refuses writes outside the
 *   jail directory;
 * - an **audit hook** that refuses reads outside the jail and the runtime,
 *   refuses to start processes, and refuses any socket that is not loopback;
 * - a **bandwidth cap** on the job of one byte a second, so traffic that got
 *   past the hook still does not leave the machine;
 * - an **environment built from nothing**, with no proxy to reach and none of
 *   the parent's secrets to send.
 *
 * It contains runaway code. It is not a boundary against code written to
 * escape — see guard.py.
 */

export type OutputStream = 'stdout' | 'stderr';

export interface OutputChunk {
  readonly stream: OutputStream;
  readonly data: string;
}

/**
 * - `ok` — the script exited 0.
 * - `error` — the script exited non-zero; `stderr` usually says why.
 * - `timeout` — it ran out of wall clock and was killed.
 * - `cancelled` — the caller aborted it.
 * - `crashed` — the runner itself failed; `detail` says how.
 */
export type RunStatus = 'ok' | 'error' | 'timeout' | 'cancelled' | 'crashed';

/** A file the script left in its working directory. */
export interface RunArtifact {
  /** Relative to the working directory, forward slashes. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SandboxLimits {
  /** Committed memory per process. Past it, allocation fails. */
  readonly memoryMb: number;
  /** Share of the whole machine's CPU, 1–100. A hard cap, not a priority. */
  readonly cpuPercent: number;
  /** Wall clock, after which the run is killed. */
  readonly timeoutMs: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  memoryMb: 1024,
  cpuPercent: 50,
  timeoutMs: 60_000,
};

/**
 * The runner and the script, and nothing else. The audit hook already refuses
 * to start processes; this is what stops a script that got around the hook.
 */
const MAX_PROCESSES = 2;

/**
 * One thread per numeric library. Left alone, each BLAS reserves a buffer per
 * core up front, which on a large machine exhausts the memory cap before the
 * script has computed anything — and threaded reductions do not sum in a
 * repeatable order anyway.
 */
const SINGLE_THREADED = Object.fromEntries(
  ['OPENBLAS', 'OMP', 'MKL', 'NUMEXPR', 'VECLIB'].map((name) => [`${name}_NUM_THREADS`, '1']),
);

/** How long past its own deadline the runner gets before it is killed too. */
const RUNNER_GRACE_MS = 5_000;

export interface RunRequest {
  readonly code: string;
  /** Names the run; generated when absent. */
  readonly executionId?: string;
  readonly limits?: Partial<SandboxLimits>;
  /** Seeds hashing and every random generator. Same seed, same run. Default 0. */
  readonly seed?: number;
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
  readonly seed: number;
  /** Which interpreter and wheels ran it: the runtime's lock hash. */
  readonly envLockHash: string;
  /** The limits the run was actually held to. */
  readonly limits: SandboxLimits;
  /** Largest committed memory of any one process in the run, when known. */
  readonly peakMemoryBytes: number | null;
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

export class SandboxLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxLimitError';
  }
}

const ENTRY = 'main.py';

const SYSTEM_ROOT = process.env['SystemRoot'] ?? 'C:\\Windows';

interface RunnerReply {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly peakMemoryBytes: number | null;
}

type RunnerMessage =
  | { method: 'output'; params: OutputChunk }
  | { id: number; result: RunnerReply }
  | { id: number; error: { message: string } };

type RunOutcome = Pick<
  RunResult,
  | 'status'
  | 'exitCode'
  | 'durationMs'
  | 'stdout'
  | 'stderr'
  | 'truncated'
  | 'peakMemoryBytes'
  | 'detail'
>;

export class Sandbox {
  readonly runtime: PythonRuntime;
  readonly #runner: string;
  readonly #guard: string;
  /** The only tree a run can write to. Labelled low integrity, once. */
  readonly #jail: string;
  readonly #cache: string;
  #labelled: Promise<void> | undefined;

  constructor(options: SandboxOptions) {
    this.runtime = options.runtime;

    // Written from the bundle on every start, outside the jail, so the code
    // that confines a script is never the script's to edit.
    const runnerDir = join(options.root, 'runner');
    mkdirSync(runnerDir, { recursive: true });
    this.#runner = join(runnerDir, 'runner.py');
    writeFileSync(this.#runner, runnerSource);
    this.#guard = join(runnerDir, 'guard.py');
    writeFileSync(this.#guard, guardSource);

    this.#jail = join(options.root, 'jail');
    // Shared between runs: matplotlib's font cache takes seconds to build.
    this.#cache = join(this.#jail, 'cache');
    mkdirSync(join(this.#cache, 'mpl'), { recursive: true });
    writeFileSync(join(this.#cache, 'mpl', 'matplotlibrc'), MATPLOTLIBRC);
  }

  async run(request: RunRequest): Promise<RunResult> {
    const limits = resolveLimits(request.limits);
    const seed = request.seed ?? 0;
    // The range PYTHONHASHSEED accepts.
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new SandboxLimitError('seed must be a whole number from 0 to 4294967295');
    }
    await (this.#labelled ??= labelLowIntegrity(this.#jail));

    const executionId = request.executionId ?? randomUUID();
    const runDir = join(this.#jail, 'runs', executionId);
    const workDir = join(runDir, 'work');
    const tempDir = join(runDir, 'tmp');
    mkdirSync(workDir, { recursive: true });
    mkdirSync(tempDir);
    writeFileSync(join(workDir, ENTRY), request.code);

    const guardConfig = {
      entry: ENTRY,
      seed,
      write: [runDir, this.#cache],
      // Fonts, because matplotlib enumerates them; nothing else of the machine's.
      read: [this.runtime.dir, join(SYSTEM_ROOT, 'Fonts')],
    };

    const outcome = await this.#drive(request, limits, {
      python: this.runtime.python,
      // -s -P: no user site-packages, and no implicit sys.path entry.
      // -B: the runtime is never written to. -X utf8: output decodes one way.
      args: ['-X', 'utf8', '-s', '-P', '-B', this.#guard, JSON.stringify(guardConfig)],
      workDir,
      env: {
        ...scrubbedEnv(tempDir),
        ...SINGLE_THREADED,
        ...deterministicEnv(seed),
        MPLCONFIGDIR: join(this.#cache, 'mpl'),
      },
      limits: {
        memoryBytes: limits.memoryMb * 1024 * 1024,
        cpuPercent: limits.cpuPercent,
        timeoutMs: limits.timeoutMs,
        maxProcesses: MAX_PROCESSES,
      },
    });

    return {
      executionId,
      ...outcome,
      artifacts: await collectArtifacts(workDir),
      codeHash: createHash('sha256').update(request.code).digest('hex'),
      seed,
      envLockHash: this.runtime.lockHash,
      limits,
      workDir,
      dispose: () => {
        rmSync(runDir, { recursive: true, force: true });
      },
    };
  }

  #drive(
    request: RunRequest,
    limits: SandboxLimits,
    params: Record<string, unknown>,
  ): Promise<RunOutcome> {
    const started = Date.now();
    const child = spawn(this.runtime.python, ['-I', '-S', this.#runner], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const out: Record<OutputStream, string> = { stdout: '', stderr: '' };
    let reply: RunnerReply | undefined;
    let failure: string | undefined;
    let runnerStderr = '';
    let stopped: 'cancelled' | 'timeout' | undefined;

    // Killing the runner closes the last handle on the job, and the kernel
    // ends everything in it: there is no orphan to chase.
    const stop = (why: 'cancelled' | 'timeout'): void => {
      stopped ??= why;
      child.kill();
    };
    const abort = (): void => {
      stop('cancelled');
    };
    if (request.signal?.aborted) abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    const backstop = setTimeout(() => {
      stop('timeout');
    }, limits.timeoutMs + RUNNER_GRACE_MS);

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
        clearTimeout(backstop);
        request.signal?.removeEventListener('abort', abort);
        const streams = { stdout: out.stdout, stderr: out.stderr };

        if (reply && !stopped) {
          resolve({
            status: reply.timedOut ? 'timeout' : reply.exitCode === 0 ? 'ok' : 'error',
            // A killed process has an exit code, but not one it chose.
            exitCode: reply.timedOut ? -1 : reply.exitCode,
            durationMs: reply.durationMs,
            truncated: reply.truncated,
            peakMemoryBytes: reply.peakMemoryBytes,
            ...streams,
          });
          return;
        }
        resolve({
          status: stopped ?? 'crashed',
          exitCode: -1,
          durationMs: Date.now() - started,
          truncated: false,
          peakMemoryBytes: null,
          ...streams,
          ...(stopped
            ? {}
            : { detail: failure ?? (runnerStderr.trim() || 'the runner exited without a result') }),
        });
      });
    });
  }
}

/**
 * A fixed moment for anything that stamps its output with the build time:
 * matplotlib's PDF and SVG writers honour it. 2000-01-01T00:00:00Z — late
 * enough for formats that cannot represent dates before 1980.
 */
const SOURCE_DATE_EPOCH = '946684800';

/**
 * Agg draws without a display and draws the same pixels everywhere. The
 * hashsalt fixes the element ids matplotlib would otherwise randomise in SVG.
 */
const MATPLOTLIBRC = ['backend: Agg', 'svg.hashsalt: sheep', ''].join('\n');

/** What has to hold in the environment for the same script to do the same thing twice. */
function deterministicEnv(seed: number): Record<string, string> {
  return {
    // Without it, str hashes — and so set order — change on every start.
    PYTHONHASHSEED: String(seed),
    SOURCE_DATE_EPOCH,
    TZ: 'UTC',
    // For a script that builds its own generators.
    SHEEP_SEED: String(seed),
  };
}

/**
 * The script's environment, built from nothing.
 *
 * Not the parent's with a few names removed: a denylist is only as good as
 * the list, and the parent's environment is where API keys and proxy settings
 * live. A script sees what Windows needs in order to run a process, a home and
 * temp directory inside the jail, and no proxy to route anything through.
 */
function scrubbedEnv(home: string): Record<string, string> {
  return {
    SystemRoot: SYSTEM_ROOT,
    windir: SYSTEM_ROOT,
    PATH: join(SYSTEM_ROOT, 'System32'),
    PROCESSOR_ARCHITECTURE: process.env['PROCESSOR_ARCHITECTURE'] ?? 'AMD64',
    TEMP: home,
    TMP: home,
    USERPROFILE: home,
    HOME: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    NO_PROXY: '*',
  };
}

function resolveLimits(requested: Partial<SandboxLimits> = {}): SandboxLimits {
  const limits = { ...DEFAULT_LIMITS, ...requested };
  const within = (name: keyof SandboxLimits, min: number, max: number): void => {
    const value = limits[name];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new SandboxLimitError(
        `${name} must be a whole number from ${String(min)} to ${String(max)}`,
      );
    }
  };
  // The floor is what the interpreter itself needs to start.
  within('memoryMb', 64, 65_536);
  within('cpuPercent', 1, 100);
  within('timeoutMs', 100, 3_600_000);
  return limits;
}

/**
 * Marks a directory, and everything later created in it, as writable by a
 * low-integrity process. Nothing else on the machine is, which is the jail.
 */
async function labelLowIntegrity(directory: string): Promise<void> {
  // ponytail: Windows only, like the Job Object; POSIX confinement is Phase 72.
  if (process.platform !== 'win32') return;
  const icacls = join(SYSTEM_ROOT, 'System32', 'icacls.exe');
  await promisify(execFile)(icacls, [directory, '/setintegritylevel', '(OI)(CI)L'], {
    windowsHide: true,
  });
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

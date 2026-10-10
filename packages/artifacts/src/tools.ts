import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import lock from '../tools.lock.json';

/**
 * The bundled rendering tools, as the lock file pins them.
 *
 * The same contract as the Python runtime: `scripts/fetch-tools.mjs` installs
 * them and stamps the directory with the hash of the lock entry it installed
 * from, and a directory whose stamp does not match the lock this build carries
 * is refused. A figure that names one toolchain and was drawn by another is
 * not reproducible, it only looks it.
 */
export interface RenderTools {
  readonly dir: string;
  /** Graphviz `dot`. */
  readonly dot: string;
  readonly tectonic: string;
  /** TeX packages Tectonic may use. Filled by the fetch script, read-only after. */
  readonly texCache: string;
  readonly versions: { readonly graphviz: string; readonly tectonic: string };
  /** Identifies both tools exactly. */
  readonly lockHash: string;
}

export class ToolsUnavailableError extends Error {
  constructor(message: string) {
    super(`${message}; run \`npm run fetch-tools\``);
    this.name = 'ToolsUnavailableError';
  }
}

/** A tool ran and said no. The message is what it printed. */
export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

const MARKER = 'sheep-tools.json';

type LockEntry = (typeof lock)['win32-x64'];

function lockEntry(): LockEntry {
  const key = `${process.platform}-${process.arch}`;
  const entry = (lock as Record<string, LockEntry | undefined>)[key];
  if (!entry) throw new ToolsUnavailableError(`no rendering tools are pinned for ${key}`);
  return entry;
}

/** Must match `lockHash` in scripts/fetch-tools.mjs. */
export function expectedToolsHash(): string {
  return createHash('sha256').update(JSON.stringify(lockEntry())).digest('hex');
}

/** Where the fetch script puts the tools in a source checkout. */
export function devToolsDir(): string {
  return join(import.meta.dirname, '..', 'tools');
}

export function locateTools(dir: string): RenderTools {
  const entry = lockEntry();
  const dot = join(dir, 'graphviz', 'bin', 'dot.exe');
  const tectonic = join(dir, 'tectonic', 'tectonic.exe');
  const markerPath = join(dir, MARKER);
  if (!existsSync(dot) || !existsSync(tectonic) || !existsSync(markerPath)) {
    throw new ToolsUnavailableError(`the rendering tools are not installed at ${dir}`);
  }

  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { lockHash?: string };
  const lockHash = expectedToolsHash();
  if (marker.lockHash !== lockHash) {
    throw new ToolsUnavailableError(
      `the rendering tools at ${dir} were installed from a different lock`,
    );
  }
  return {
    dir,
    dot,
    tectonic,
    texCache: join(dir, 'tex-cache'),
    versions: { graphviz: entry.graphviz.version, tectonic: entry.tectonic.version },
    lockHash,
  };
}

/**
 * A fixed moment for anything that stamps its output with the build time —
 * cairo's PDF writer and xdvipdfmx both honour it. The sandbox's value, for
 * the sandbox's reason: 2000-01-01T00:00:00Z.
 */
const SOURCE_DATE_EPOCH = '946684800';

const SYSTEM_ROOT = process.env['SystemRoot'] ?? 'C:\\Windows';

/**
 * A tool's environment, built from nothing, as the sandbox builds a script's:
 * what Windows needs to start a process, and no key or proxy of the parent's.
 */
export function toolEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    SystemRoot: SYSTEM_ROOT,
    windir: SYSTEM_ROOT,
    PATH: join(SYSTEM_ROOT, 'System32'),
    SOURCE_DATE_EPOCH,
    TZ: 'UTC',
    ...extra,
  };
}

export interface ToolRun {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Record<string, string>;
  /** Written to the tool's stdin, which is then closed. */
  readonly input?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Runs one tool to completion and returns what it wrote to stdout.
 *
 * A non-zero exit or a timeout is a `RenderError` carrying the tool's own
 * words, since those are what say which line of the source was wrong.
 *
 * ponytail: a wall clock is the only limit. The source is model-written, but
 * these are renderers, not interpreters given a shell; put them in a Job
 * Object like the sandbox if one ever needs a memory cap.
 */
export function runTool(executable: string, run: ToolRun): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...run.args], {
      cwd: run.cwd,
      env: run.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: run.timeoutMs,
      signal: run.signal,
    });

    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on('error', () => {
      // The tool exited before reading its input; `close` reports it.
    });
    child.stdin.end(run.input ?? '');

    child.on('error', (error) => {
      reject(new RenderError(error.name === 'AbortError' ? 'cancelled' : error.message));
    });
    child.on('close', (code, signal) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else if (signal !== null) {
        reject(new RenderError(`stopped after ${String(run.timeoutMs)}ms without finishing`));
      } else {
        const said = stderr.trim() || Buffer.concat(stdout).toString('utf8').trim();
        reject(new RenderError(said || `exited with code ${String(code)}`));
      }
    });
  });
}

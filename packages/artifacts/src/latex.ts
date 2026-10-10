import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { formulaDocument, formulaProblem } from './formula';
import type { Rendering } from './graphviz';
import { RenderError, runTool, toolEnv, type RenderTools } from './tools';

/**
 * Real LaTeX, typeset by the bundled Tectonic.
 *
 * Two things are asked of the engine and both are flags: `--untrusted`, since
 * the source is model-written and must not be able to run a command, and
 * `--only-cached`, since rendering never reaches the network — the packages a
 * figure may use were fetched once, by `npm run fetch-tools`, and a source
 * that wants another is told so.
 *
 * Neither flag keeps TeX inside its directory: `\openout` and `\input` take any
 * path. So the engine also runs at low integrity, where the kernel refuses its
 * writes anywhere else, and a result that read a file from anywhere else is
 * thrown away — see `typeset`.
 *
 * The PDF is a function of the source alone: xdvipdfmx stamps it from the
 * fixed `SOURCE_DATE_EPOCH` the tool environment sets rather than the clock.
 */

const TECTONIC_TIMEOUT_MS = 120_000;

/**
 * TeX says what went wrong on a line starting `!` and where on one starting
 * `l.<number>`. Those are the two lines worth showing out of a page of log.
 */
function texProblem(log: string): string {
  const lines = log.split(/\r?\n/);
  const said = lines.filter((line) => /^(! |l\.\d+ )/.test(line)).slice(0, 6);
  if (said.length === 0) return lines.filter((line) => line.startsWith('error:')).join('\n') || log;

  const missing = /File `([^']+)' not found/.exec(log);
  return missing
    ? `${said.join('\n')}\n${missing[1] ?? 'that file'} is not among the TeX packages bundled with Sheep`
    : said.join('\n');
}

/** One file of a document: where it goes, relative to the document, and what is in it. */
export interface TexFile {
  readonly path: string;
  readonly data: Uint8Array | string;
}

const ICACLS = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe');

/** Labels a path low integrity: a low process may write there, and nowhere unlabelled. */
function labelLow(path: string, inherit = ''): void {
  execFileSync(ICACLS, [path, '/setintegritylevel', inherit + 'L'], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

/**
 * A copy of Tectonic that Windows starts at low integrity.
 *
 * A process started from an executable labelled low runs low, and the kernel
 * refuses a low process's writes to anything not labelled low itself — which
 * only the build directory is. A copy, because the installed one has to stay
 * able to fill its cache when `fetch-tools` runs it.
 */
function confinedTectonic(tools: RenderTools): string {
  const copy = join(tmpdir(), 'sheep-tectonic-' + tools.lockHash.slice(0, 12) + '.exe');
  if (!existsSync(copy) || statSync(copy).size !== statSync(tools.tectonic).size) {
    copyFileSync(tools.tectonic, copy);
  }
  labelLow(copy);
  return copy;
}

/** A path that stays inside the build directory, or an error. */
function inside(root: string, path: string): string {
  const target = normalize(join(root, path));
  if (isAbsolute(path) || !target.startsWith(root + sep)) {
    throw new Error('not a path inside the document: ' + path);
  }
  return target;
}

const ABSOLUTE_READ = /accessing absolute path `([^`]*)`/;

const refusal = (path: string): RenderError =>
  new RenderError(
    'error: the source reads a file outside the document (' + path + '), which is not allowed',
  );

/** The first file the engine read that is not one of the document's own, if any. */
function outsideRead(root: string, rules: string): string | undefined {
  // Makefile rules: the target, a colon, then every input, continued across lines.
  const inputs = rules
    .slice(rules.indexOf(':') + 1)
    .split(/\s+/)
    .map((input) => input.replace(/\\$/, ''));
  return inputs.find((input) => {
    if (input === '') return false;
    // No file of a document has a colon in its name; `D:notes` is another drive.
    if (input.includes(':')) return true;
    try {
      inside(root, input);
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * Typesets a document from its files, confined, and returns the PDF and what
 * the engine remarked on the way.
 *
 * Nothing is left behind: the files are written to a directory of their own,
 * compiled there, and the directory is removed whatever happened. A failure is
 * a `RenderError` in the engine's own words.
 *
 * The engine lists every file it read, under a name the source cannot guess
 * and so cannot overwrite. If one of them is not the document's own, the PDF
 * is not returned: whatever was read never reaches an artifact or a paper.
 *
 * ponytail: Windows only, like the tools themselves. When they are pinned for
 * another platform this needs that platform's confinement, not a skip.
 */
export async function typeset(
  tools: RenderTools,
  files: readonly TexFile[],
  options: { readonly main: string; readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<{ pdf: Uint8Array; remarks: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'sheep-tex-'));
  try {
    for (const file of files) {
      const target = inside(dir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.data);
    }

    let tectonic: string;
    try {
      tectonic = confinedTectonic(tools);
      labelLow(dir, '(OI)(CI)');
    } catch (error) {
      // Running it unconfined is the alternative, and it is not on the table.
      const why = error instanceof Error ? error.message.split('\n')[0] : String(error);
      throw new RenderError(
        'error: the typesetter could not be confined, so it was not run (' + String(why) + ')',
      );
    }

    const rules = randomUUID() + '.d';
    let remarks = '';
    try {
      await runTool(tectonic, {
        args: [
          '-X',
          'compile',
          '--untrusted',
          '--only-cached',
          '--makefile-rules',
          rules,
          options.main,
        ],
        cwd: dir,
        env: toolEnv({ TECTONIC_CACHE_DIR: tools.texCache }),
        timeoutMs: options.timeoutMs,
        onStderr: (text) => {
          remarks = text;
        },
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      // What TeX says about a file it could not make sense of quotes the file.
      const read = error instanceof RenderError ? ABSOLUTE_READ.exec(error.message) : null;
      if (read) throw refusal(read[1] ?? 'an absolute path');
      throw error;
    }

    const read = outsideRead(dir, readFileSync(join(dir, rules), 'utf8'));
    if (read !== undefined) throw refusal(read);
    return { pdf: readFileSync(join(dir, options.main.replace(/\.tex$/, '.pdf'))), remarks };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Typesets one complete LaTeX document to PDF. */
export async function compileLatex(
  tools: RenderTools,
  document: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  try {
    const { pdf } = await typeset(tools, [{ path: 'figure.tex', data: document }], {
      main: 'figure.tex',
      timeoutMs: TECTONIC_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    return pdf;
  } catch (error) {
    if (error instanceof RenderError) throw new RenderError(texProblem(error.message));
    throw error;
  }
}

/**
 * A TikZ source as a document.
 *
 * A source that is already a document is typeset as written. Anything else is
 * taken to be the picture itself and given the smallest document that holds
 * one, cropped to it, with pgfplots and the common libraries loaded.
 */
export function tikzDocument(source: string): string {
  if (source.includes('\\documentclass')) return source;
  const picture = source.includes('\\begin{tikzpicture}')
    ? source.trim()
    : `\\begin{tikzpicture}\n${source.trim()}\n\\end{tikzpicture}`;
  return [
    '\\documentclass[tikz,border=2pt]{standalone}',
    '\\usepackage{amsmath,amssymb}',
    '\\usepackage{pgfplots}',
    '\\pgfplotsset{compat=1.18}',
    '\\usetikzlibrary{arrows.meta,positioning,calc,shapes.geometric,fit,backgrounds,patterns,matrix,decorations.pathreplacing}',
    '\\begin{document}',
    picture,
    '\\end{document}',
    '',
  ].join('\n');
}

const toolchain = (tools: RenderTools): string => `tectonic ${tools.versions.tectonic}`;

export async function renderTikz(
  tools: RenderTools,
  source: string,
  signal?: AbortSignal,
): Promise<Rendering> {
  const data = await compileLatex(tools, tikzDocument(source), signal);
  return { outputs: [{ path: 'figure.pdf', data }], toolchain: toolchain(tools) };
}

/**
 * A formula for print.
 *
 * Read by KaTeX first: it answers at once and names the character, where TeX
 * would answer a second later with a line number in a document the author
 * never saw. Whatever KaTeX can read, the engine typesets.
 */
export async function renderFormula(
  tools: RenderTools,
  latex: string,
  signal?: AbortSignal,
): Promise<Rendering> {
  const problem = formulaProblem(latex);
  if (problem !== null) throw new RenderError(problem);
  const data = await compileLatex(tools, formulaDocument(latex), signal);
  return { outputs: [{ path: 'formula.pdf', data }], toolchain: toolchain(tools) };
}

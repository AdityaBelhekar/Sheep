import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** Typesets one complete LaTeX document to PDF. */
export async function compileLatex(
  tools: RenderTools,
  document: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), 'sheep-tex-'));
  try {
    writeFileSync(join(dir, 'figure.tex'), document);
    await runTool(tools.tectonic, {
      args: ['-X', 'compile', '--untrusted', '--only-cached', 'figure.tex'],
      cwd: dir,
      env: toolEnv({ TECTONIC_CACHE_DIR: tools.texCache }),
      timeoutMs: TECTONIC_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    return readFileSync(join(dir, 'figure.pdf'));
  } catch (error) {
    if (error instanceof RenderError) throw new RenderError(texProblem(error.message));
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

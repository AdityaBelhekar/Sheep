import { RenderError, typeset, type RenderTools } from '@sheep/artifacts';

/**
 * The LaTeX engine, driven for whole documents.
 *
 * A paper is several files — the text, its figures, a conference's style file
 * — typeset together by the bundled Tectonic. It runs exactly as it does for a
 * single figure: untrusted and confined to the document's own directory, since
 * most of what it reads was written by models, and against its cache alone, since compiling a paper is not a reason to
 * reach the network. It reruns itself until references settle, so one call is
 * one finished PDF.
 *
 * The PDF is a function of the files alone: its dates come from a fixed
 * `SOURCE_DATE_EPOCH`, so the same record compiles to the same bytes.
 */

/** One file of a document: where it goes, relative to the document, and what is in it. */
export interface PaperFile {
  readonly path: string;
  readonly data: Uint8Array | string;
}

/** Something the engine said about a line of the source. */
export interface LatexProblem {
  readonly severity: 'error' | 'warning';
  /** The file it was said about, when the engine named one. */
  readonly file: string | null;
  readonly line: number | null;
  readonly message: string;
}

/** The document did not compile. `problems` says where; `log` is everything the engine printed. */
export class LatexError extends Error {
  constructor(
    readonly problems: readonly LatexProblem[],
    readonly log: string,
  ) {
    super(
      problems
        .filter((problem) => problem.severity === 'error')
        .map(describeProblem)
        .join('\n') || 'the document did not compile',
    );
    this.name = 'LatexError';
  }
}

export function describeProblem(problem: LatexProblem): string {
  const where =
    problem.file === null
      ? ''
      : `${problem.file}${problem.line === null ? '' : `:${String(problem.line)}`}: `;
  return `${where}${problem.message}`;
}

export interface CompiledPaper {
  readonly pdf: Uint8Array;
  /** What the engine remarked on without failing. */
  readonly warnings: readonly LatexProblem[];
}

const TIMEOUT_MS = 300_000;

/** The most warnings kept. Past this they are boxes a point too wide, a hundred times over. */
const MAX_WARNINGS = 40;

/** Remarks that are about the machine or the engine, not about the document. */
const NOISE =
  /Fontconfig|accessing absolute path|Rerunning TeX|Underfull|Requested font|newer than current output PDF|warnings were issued|^\s*$/i;

/**
 * Tectonic reports as `error: paper.tex:41: ! Undefined control sequence.` —
 * severity, file, line, and TeX's own words. Lines without a location are kept
 * too: "File `x.sty' not found" has none and matters most.
 */
export function parseProblems(output: string): LatexProblem[] {
  const problems: LatexProblem[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const located = /^(error|warning): ([^:\s][^:]*):(\d+): (.+)$/.exec(line);
    const bare = located ? null : /^(error|warning): (.+)$/.exec(line);
    const problem: LatexProblem | null = located
      ? {
          severity: located[1] as LatexProblem['severity'],
          file: located[2] ?? null,
          line: Number(located[3]),
          message: (located[4] ?? '').replace(/^! /, ''),
        }
      : bare
        ? {
            severity: bare[1] as LatexProblem['severity'],
            file: null,
            line: null,
            message: bare[2] ?? '',
          }
        : null;
    if (!problem || NOISE.test(problem.message)) continue;
    // "halted on potentially-recoverable error" follows every real one and adds nothing.
    if (/unrecoverable error|something bad happened inside/.test(problem.message)) continue;

    const key = describeProblem(problem);
    if (seen.has(key)) continue;
    seen.add(key);

    const missing = /File `([^']+)' not found/.exec(problem.message);
    problems.push(
      missing
        ? {
            ...problem,
            message: `${problem.message} ${missing[1] ?? 'It'} is not among the TeX packages bundled with Sheep; run \`npm run fetch-tools\` if it should be.`,
          }
        : problem,
    );
  }
  return problems;
}

/**
 * Typesets a document from its files and returns the PDF.
 *
 * Nothing is left behind: the files are written to a directory of their own,
 * compiled there, and the directory is removed whatever happened.
 */
export async function compileLatex(
  tools: RenderTools,
  files: readonly PaperFile[],
  options: { readonly main?: string; readonly signal?: AbortSignal } = {},
): Promise<CompiledPaper> {
  const main = options.main ?? 'paper.tex';
  if (!files.some((file) => file.path === main)) {
    throw new Error(`the document has no ${main}`);
  }

  try {
    const { pdf, remarks } = await typeset(tools, files, {
      main,
      timeoutMs: TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      pdf,
      warnings: parseProblems(remarks)
        .filter((problem) => problem.severity === 'warning')
        .slice(0, MAX_WARNINGS),
    };
  } catch (error) {
    if (!(error instanceof RenderError)) throw error;
    const problems = parseProblems(error.message);
    throw new LatexError(
      problems.some((problem) => problem.severity === 'error')
        ? problems
        : [
            ...problems,
            { severity: 'error', file: null, line: null, message: error.message.slice(-2_000) },
          ],
      error.message,
    );
  }
}

import katex, { type KatexOptions } from 'katex';

/**
 * Formulas.
 *
 * LaTeX is the canonical form: it is what a formula is stored as, what the
 * checker emits, and what the paper is typeset from. Everything else is a
 * rendering of it — KaTeX for the screen, because it is immediate, and a real
 * LaTeX document for print, because a paper is not a web page.
 *
 * Nothing here touches the file system or starts a process, so the renderer
 * imports this module directly (`@sheep/artifacts/formula`).
 */

/** The most LaTeX one formula may be. A formula, not a document. */
export const MAX_FORMULA_LENGTH = 4_000;

/**
 * How KaTeX is asked to read a formula, everywhere.
 *
 * `trust: false` is the one that matters: the LaTeX is something a model
 * wrote, and with it off there is no `\href`, no `\includegraphics` and no raw
 * HTML for it to reach. A formula KaTeX cannot read is drawn as its source in
 * the error colour rather than thrown — an unreadable formula is still shown.
 */
export const KATEX_OPTIONS: KatexOptions = {
  throwOnError: false,
  trust: false,
  strict: 'ignore',
  maxExpand: 1_000,
  output: 'htmlAndMathml',
};

/** Why KaTeX cannot read a formula, or null when it can. */
export function formulaProblem(latex: string): string | null {
  if (latex.trim() === '') return 'the formula is empty';
  if (latex.length > MAX_FORMULA_LENGTH) {
    return `the formula is longer than ${String(MAX_FORMULA_LENGTH)} characters`;
  }
  try {
    katex.renderToString(latex, { ...KATEX_OPTIONS, throwOnError: true });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The screen rendering, as markup. Never throws; see `KATEX_OPTIONS`. */
export function formulaHtml(latex: string, displayMode = false): string {
  return katex.renderToString(latex, { ...KATEX_OPTIONS, displayMode });
}

/**
 * The print rendering: a complete LaTeX document holding only the formula,
 * cropped to it, for a real TeX engine to typeset.
 *
 * amsmath and amssymb because that is the dialect both SymPy and KaTeX speak;
 * a formula that previews on screen should compile here unchanged.
 */
export function formulaDocument(latex: string): string {
  return [
    '\\documentclass[border=2pt]{standalone}',
    '\\usepackage{amsmath,amssymb}',
    '\\begin{document}',
    // The trailing % keeps a formula ending in a comment from eating the `$`.
    `$\\displaystyle ${latex.trim()}%`,
    '$',
    '\\end{document}',
    '',
  ].join('\n');
}

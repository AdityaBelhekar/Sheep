import { describe, expect, it } from 'vitest';
import { formulaDocument, formulaHtml, formulaProblem, MAX_FORMULA_LENGTH } from './formula';

describe('formula pipeline', () => {
  it('typesets LaTeX for the screen, with MathML beside the HTML', () => {
    const html = formulaHtml('W = \\frac{m v^{2}}{2}');
    expect(html).toContain('<math');
    expect(html).toContain('<mfrac>');
    expect(html).toContain('class="katex-html"');
  });

  it('typesets what SymPy emits', () => {
    for (const latex of [
      '\\frac{d}{d x} y = 2 x + 2',
      '\\left(x + 1\\right)^{2}',
      '\\operatorname{asin}{\\left(\\theta \\right)}',
      '\\int\\limits_{0}^{\\infty} e^{- x}\\, dx',
    ]) {
      expect(formulaProblem(latex), latex).toBeNull();
    }
  });

  it('reports a formula it cannot read instead of throwing', () => {
    expect(formulaProblem('\\frac{1}{')).toMatch(/parse error/i);
    expect(formulaProblem('   ')).toMatch(/empty/);
    expect(formulaProblem('x'.repeat(MAX_FORMULA_LENGTH + 1))).toMatch(/longer/);
    // Still drawn — as its own source, marked as an error.
    expect(formulaHtml('\\frac{1}{')).toContain('katex-error');
  });

  it('gives a model-written formula no way to emit a link or markup', () => {
    const html = formulaHtml('\\href{javascript:alert(1)}{x} \\htmlClass{evil}{y} <script>');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('class="evil"');
    expect(html).not.toContain('<script>');
  });

  it('wraps the same LaTeX in a standalone document for print', () => {
    const document = formulaDocument('  E = m c^{2} % rest mass\n');
    expect(document).toContain('\\documentclass[border=2pt]{standalone}');
    expect(document).toContain('\\usepackage{amsmath,amssymb}');
    // The comment cannot swallow the closing delimiter.
    expect(document).toContain('$\\displaystyle E = m c^{2} % rest mass%\n$');
    expect(document.trimEnd().endsWith('\\end{document}')).toBe(true);
  });
});

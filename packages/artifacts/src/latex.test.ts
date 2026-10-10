import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { renderFormula, renderTikz, tikzDocument } from './latex';
import { devToolsDir, locateTools, RenderError } from './tools';

// Every test here starts a real TeX engine.
vi.setConfig({ testTimeout: 120_000 });

const tools = locateTools(devToolsDir());

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const isPdf = (data: Uint8Array): boolean =>
  Buffer.from(data.subarray(0, 5)).toString('latin1') === '%PDF-';

const PICTURE = `
\\node[draw, rounded corners] (claim) {Claim};
\\node[draw, right=of claim] (run) {Execution $\\int_0^1 x\\,\\mathrm{d}x$};
\\draw[-{Stealth}] (run) -- node[above] {backs} (claim);
`;

describe('tikz', () => {
  it('wraps a bare picture, and leaves a whole document alone', () => {
    const wrapped = tikzDocument(PICTURE);
    expect(wrapped).toContain('\\documentclass[tikz,border=2pt]{standalone}');
    expect(wrapped).toContain('\\begin{tikzpicture}');
    expect(tikzDocument(wrapped)).toBe(wrapped);

    const own = '\\begin{tikzpicture}[scale=2]\\draw (0,0) -- (1,1);\\end{tikzpicture}';
    expect(tikzDocument(own).match(/\\begin\{tikzpicture\}/g)).toHaveLength(1);
  });

  it('typesets a picture to PDF, offline, and to the same bytes each time', async () => {
    const first = await renderTikz(tools, PICTURE);
    // A PDF stamped with the clock would differ across a second boundary.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await renderTikz(tools, PICTURE);

    expect(first.toolchain).toBe(`tectonic ${tools.versions.tectonic}`);
    expect(first.outputs.map((output) => output.path)).toEqual(['figure.pdf']);
    expect(isPdf(first.outputs[0]!.data)).toBe(true);
    expect(sha256(second.outputs[0]!.data)).toBe(sha256(first.outputs[0]!.data));
  });

  it('typesets a pgfplots axis', async () => {
    const { outputs } = await renderTikz(
      tools,
      '\\begin{axis}[xlabel=$x$]\\addplot[domain=0:3]{x^2};\\end{axis}',
    );
    expect(isPdf(outputs[0]!.data)).toBe(true);
  });

  it('reports what TeX said and where, not the whole log', async () => {
    const failure = renderTikz(tools, '\\node {a};\n\\notacommand\n');
    await expect(failure).rejects.toThrow(RenderError);
    await expect(failure).rejects.toThrow(/^! Undefined control sequence\.\nl\.\d+ \\notacommand$/);
  });

  it('says so when a source wants a package that is not bundled', async () => {
    await expect(
      renderTikz(
        tools,
        '\\documentclass{article}\\usepackage{sheepdoesnotshipthis}\\begin{document}x\\end{document}',
      ),
    ).rejects.toThrow(/sheepdoesnotshipthis\.sty is not among the TeX packages bundled/);
  });

  it('cannot be made to run a command', async () => {
    await expect(
      renderTikz(
        tools,
        '\\documentclass{article}\\begin{document}\\immediate\\write18{echo x > escaped.txt}\\input{|"echo hi"}\\end{document}',
      ),
    ).rejects.toThrow(RenderError);
  });
});

describe('formula for print', () => {
  it('typesets the canonical LaTeX to the same PDF each time', async () => {
    const latex = 'W = \\frac{m v^{2}}{2}';
    const first = await renderFormula(tools, latex);
    const second = await renderFormula(tools, latex);

    expect(first.outputs.map((output) => output.path)).toEqual(['formula.pdf']);
    expect(isPdf(first.outputs[0]!.data)).toBe(true);
    expect(sha256(second.outputs[0]!.data)).toBe(sha256(first.outputs[0]!.data));
  });

  it('refuses a formula KaTeX cannot read before starting an engine', async () => {
    await expect(renderFormula(tools, '\\frac{1}{')).rejects.toThrow(/parse error/i);
  });
});

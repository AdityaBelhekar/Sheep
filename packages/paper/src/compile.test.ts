import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { devToolsDir, locateTools, renderGraphviz } from '@sheep/artifacts';
import { compileLatex, LatexError, parseProblems } from './compile';

// Every test here starts a real TeX engine.
vi.setConfig({ testTimeout: 180_000 });

const tools = locateTools(devToolsDir());
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const isPdf = (data: Uint8Array): boolean =>
  Buffer.from(data.subarray(0, 5)).toString('latin1') === '%PDF-';

const doc = (body: string): string =>
  [
    '\\documentclass{article}',
    '\\usepackage{graphicx}',
    '\\usepackage{hyperref}',
    '\\begin{document}',
    body,
    '\\end{document}',
    '',
  ].join('\n');

describe('the LaTeX engine', () => {
  it('typesets a document of several files, offline, with references settled', async () => {
    const figure = (await renderGraphviz(tools, 'digraph { a -> b }')).outputs[1]!.data;
    const { pdf, warnings } = await compileLatex(tools, [
      {
        path: 'paper.tex',
        data: doc(
          '\\section{One}\\label{s}\nSee Section~\\ref{s} and Figure~\\ref{f}.\\input{parts/more}\n' +
            '\\begin{figure}\\includegraphics{figures/a.pdf}\\caption{A}\\label{f}\\end{figure}',
        ),
      },
      { path: 'parts/more.tex', data: 'More text.' },
      { path: 'figures/a.pdf', data: figure },
    ]);

    expect(isPdf(pdf)).toBe(true);
    // An unresolved \ref would be reported; the engine reran until there was none.
    expect(warnings.map((warning) => warning.message).join('\n')).not.toMatch(/undefined/i);
  });

  it('compiles the same files to the same bytes', async () => {
    const files = [{ path: 'paper.tex', data: doc('\\section{Same}\\today') }];
    const first = await compileLatex(tools, files);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await compileLatex(tools, files);
    expect(sha256(second.pdf)).toBe(sha256(first.pdf));
  });

  it('says which file and line an error is on, in TeX’s words', async () => {
    const failure = compileLatex(tools, [
      { path: 'paper.tex', data: doc('Fine so far.\n\\input{parts/broken}') },
      { path: 'parts/broken.tex', data: 'line one\n\\notacommand\n' },
    ]);
    await expect(failure).rejects.toThrow(LatexError);
    const error = (await failure.catch((caught: unknown) => caught)) as LatexError;

    expect(error.problems.filter((problem) => problem.severity === 'error')).toEqual([
      {
        severity: 'error',
        file: 'parts/broken',
        line: 2,
        message: 'Undefined control sequence',
      },
    ]);
    expect(error.message).toBe('parts/broken:2: Undefined control sequence');
    expect(error.log).toContain('\\notacommand');
  });

  it('says so when a document wants a package that is not bundled', async () => {
    const error = (await compileLatex(tools, [
      {
        path: 'paper.tex',
        data: '\\documentclass{article}\\usepackage{sheepdoesnotshipthis}\\begin{document}x\\end{document}',
      },
    ]).catch((caught: unknown) => caught)) as LatexError;

    expect(error).toBeInstanceOf(LatexError);
    expect(error.message).toMatch(/sheepdoesnotshipthis\.sty is not among the TeX packages/);
  });

  it('refuses a file outside the document', async () => {
    await expect(
      compileLatex(tools, [
        { path: 'paper.tex', data: doc('x') },
        { path: '../escaped.tex', data: 'x' },
      ]),
    ).rejects.toThrow(/not a path inside the document/);
    await expect(compileLatex(tools, [{ path: 'other.tex', data: 'x' }])).rejects.toThrow(
      /no paper\.tex/,
    );
  });
});

describe('reading what the engine printed', () => {
  it('keeps what is about the document and drops what is about the machine', () => {
    const problems = parseProblems(
      [
        'note: Running TeX ...',
        'Fontconfig error: Cannot load default config file',
        'warning: paper.tex:12: Underfull \\hbox (badness 10000) in paragraph',
        'warning: paper.tex:40: Overfull \\hbox (12.0pt too wide) in paragraph at lines 40--41',
        'warning: Trying to include PDF file with version (1.7), which is newer than current output PDF setting (1.5).',
        'error: paper.tex:41: ! Missing $ inserted.',
        'error: paper.tex:41: ! Missing $ inserted.',
        'error: the XeTeX engine had an unrecoverable error',
      ].join('\n'),
    );
    expect(problems).toEqual([
      {
        severity: 'warning',
        file: 'paper.tex',
        line: 40,
        message: 'Overfull \\hbox (12.0pt too wide) in paragraph at lines 40--41',
      },
      { severity: 'error', file: 'paper.tex', line: 41, message: 'Missing $ inserted.' },
    ]);
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { devToolsDir, locateTools, renderGraphviz } from '@sheep/artifacts';
import { emitBody, escapeLatex, mono, prose } from './latex';
import { typesetPaper } from './paper';
import { emitLatex, templateById, TEMPLATES } from './templates';
import { SAMPLE_CLAIM, sampleDocument } from './test-support';

// Every compile here starts a real TeX engine, on a whole document.
vi.setConfig({ testTimeout: 300_000 });

const tools = locateTools(devToolsDir());
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

describe('escaping', () => {
  it('leaves a model no character with which to write LaTeX', () => {
    expect(escapeLatex('\\input{/etc/passwd} $x_1$ 50% & #1 ^ ~')).toBe(
      '\\textbackslash{}input\\{/etc/passwd\\} \\$x\\_1\\$ 50\\% \\& \\#1 \\textasciicircum{} \\textasciitilde{}',
    );
    expect(escapeLatex('n ≥ 10 → done\u0007')).toBe('n $\\geq$ 10 $\\rightarrow$ done');
  });

  it('keeps the lines and paragraphs of quoted text', () => {
    expect(prose('1. Scope\n2. Limits\n\n\nA second paragraph.')).toBe(
      '1. Scope\\newline\n2. Limits\n\nA second paragraph.',
    );
  });

  it('lets a hash break across lines without changing what it says', () => {
    const hash = 'ab'.repeat(32);
    const set = mono(hash);
    expect(set.replaceAll('\\allowbreak{}', '')).toBe(`\\texttt{${hash}}`);
    expect(set.match(/\\allowbreak/g)).toHaveLength(7);
  });
});

describe('the body', () => {
  const body = emitBody(sampleDocument());

  it('writes each claim’s ledger id into the source beside the sentence that rests on it', () => {
    expect(body).toContain(`% claim ${SAMPLE_CLAIM}`);
    expect(body).toContain(`C1 holds at the sample sizes tried.\\sheepclaim{C1}{${SAMPLE_CLAIM}}`);
    // A framing sentence asserts nothing and is tagged with nothing.
    expect(body).toContain('This record answers one question:\n');
  });

  it('is the same text whichever template wraps it', () => {
    for (const template of TEMPLATES) {
      expect(emitLatex(sampleDocument(), template), template.id).toContain(body);
    }
  });

  it('cannot have its listing closed early by the script it lists', () => {
    const document = sampleDocument();
    const hostile = {
      ...document,
      sections: [
        {
          id: 'method',
          title: 'Method',
          blocks: [
            {
              kind: 'code' as const,
              caption: 'A script',
              text: 'print(1)\n\\end{lstlisting}\n\\input{secrets}\n',
            },
          ],
        },
      ],
    };
    expect(emitBody(hostile).match(/\\end\{lstlisting\}/g)).toHaveLength(1);
  });
});

describe('templates', () => {
  it('refuses a template that does not exist', () => {
    expect(() => templateById('nature')).toThrow(/unknown template/);
  });

  it.each(TEMPLATES)('typesets the sample paper as $label, offline', async (template) => {
    const figure = (await renderGraphviz(tools, 'digraph { rankdir=LR; samples -> estimate }'))
      .outputs[1]!.data;
    const document = sampleDocument();
    const read = (): Uint8Array => figure;

    const paper = await typesetPaper(document, template, tools, read);

    expect(Buffer.from(paper.pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(paper.files.map((file) => file.path)).toEqual([
      'paper.tex',
      'figures/figure-1.pdf',
      ...template.styleFiles.map((file) => file.slice(file.indexOf('/') + 1)),
    ]);
    // Nothing the document itself got wrong: no undefined reference, no missing glyph.
    expect(paper.warnings.map((warning) => warning.message).join('\n')).not.toMatch(
      /undefined|Missing character/i,
    );

    // And the same record is the same file.
    const again = await typesetPaper(document, template, tools, read);
    expect(sha256(again.pdf)).toBe(sha256(paper.pdf));
  });
});

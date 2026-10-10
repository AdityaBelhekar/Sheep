import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { RenderTools } from '@sheep/artifacts';
import { compileLatex, type CompiledPaper, type PaperFile } from './compile';
import { figuresIn, type PaperDocument } from './ir';
import { emitLatex, type PaperTemplate } from './templates';

/**
 * Every file a paper is compiled from: the LaTeX, the figures it includes, and
 * the style files its template needs.
 *
 * A figure is read by the content address the document recorded for it, so
 * what is typeset is the rendering the ledger names and not whatever happens
 * to be called `figure-1.pdf`.
 */
export function paperFiles(
  document: PaperDocument,
  template: PaperTemplate,
  tools: RenderTools,
  read: (hash: string) => Uint8Array,
): PaperFile[] {
  return [
    { path: 'paper.tex', data: emitLatex(document, template) },
    ...figuresIn(document).map((figure) => ({ path: figure.file, data: read(figure.hash) })),
    ...template.styleFiles.map((file) => ({
      path: basename(file),
      data: readFileSync(join(tools.styles, file)),
    })),
  ];
}

export interface TypesetPaper extends CompiledPaper {
  /** What was compiled, so it can be kept beside the PDF. */
  readonly files: readonly PaperFile[];
}

/** Typesets a document in a template. Throws `LatexError` when the engine refuses it. */
export async function typesetPaper(
  document: PaperDocument,
  template: PaperTemplate,
  tools: RenderTools,
  read: (hash: string) => Uint8Array,
  signal?: AbortSignal,
): Promise<TypesetPaper> {
  const files = paperFiles(document, template, tools, read);
  return { ...(await compileLatex(tools, files, signal ? { signal } : {})), files };
}

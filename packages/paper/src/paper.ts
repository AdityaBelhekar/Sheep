import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { RenderTools } from '@sheep/artifacts';
import { compileLatex, type CompiledPaper, type PaperFile } from './compile';
import { buildDocument, figuresIn, type PaperDocument, type PaperSource } from './ir';
import {
  assertProvenanced,
  provenanceAppendix,
  withoutUnprovenanced,
  type BuildFacts,
  type Unprovenanced,
} from './provenance';
import { emitLatex, templateById, type PaperTemplate } from './templates';

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

/**
 * Typesets a document in a template.
 *
 * This is the only way to a PDF, and the provenance rule is its first line: a
 * document in which the paper asserts something with no ledger claim behind
 * it throws `ProvenanceError` before any LaTeX is written. `LatexError` is
 * what the engine refusing the result looks like.
 */
export async function typesetPaper(
  document: PaperDocument,
  template: PaperTemplate,
  tools: RenderTools,
  read: (hash: string) => Uint8Array,
  signal?: AbortSignal,
): Promise<TypesetPaper> {
  assertProvenanced(document);
  const files = paperFiles(document, template, tools, read);
  return { ...(await compileLatex(tools, files, signal ? { signal } : {})), files };
}

export interface PaperOptions {
  readonly template: string;
  /**
   * Leave out sentences that assert something and name no claim, instead of
   * refusing to build. Off by default: the default answer to an unprovenanced
   * sentence is no paper.
   */
  readonly omitUnprovenanced?: boolean;
  readonly signal?: AbortSignal;
}

export interface BuiltPaper extends TypesetPaper {
  /** The document that was typeset, appendix included. */
  readonly document: PaperDocument;
  readonly build: BuildFacts;
  /** What `omitUnprovenanced` left out. Empty when it was off, since then nothing may be. */
  readonly omitted: readonly Unprovenanced[];
}

/**
 * A session's record, compiled: read into a document, given its provenance
 * appendix, checked, and typeset.
 */
export async function buildPaper(
  source: PaperSource,
  tools: RenderTools,
  options: PaperOptions,
): Promise<BuiltPaper> {
  const template = templateById(options.template);
  const whole = buildDocument(source);
  const { document: body, omitted } = options.omitUnprovenanced
    ? withoutUnprovenanced(whole)
    : { document: whole, omitted: [] };

  const build: BuildFacts = {
    template: template.label,
    engine: `Tectonic ${tools.versions.tectonic}`,
    toolsLockHash: tools.lockHash,
    omitted: omitted.length,
  };
  const document = { ...body, appendix: provenanceAppendix(source, build) };
  const paper = await typesetPaper(document, template, tools, source.read, options.signal);
  return { ...paper, document, build, omitted };
}

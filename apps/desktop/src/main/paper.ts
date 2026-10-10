import type { IpcRequest, IpcResponse } from '@sheep/ipc';
import {
  buildDocument,
  figuresIn,
  LatexError,
  templateById,
  TEMPLATES,
  typesetPaper,
} from '@sheep/paper';
import { getTools } from './artifacts';
import { readPaperSource } from './paper-source';
import { getStore } from './store';

/**
 * The Paper pane's side of the compiler: read the session, build the document,
 * typeset it.
 *
 * A paper that does not compile is an answer, not an error. The reply says
 * what is wrong and where, in the same shape whether the engine refused the
 * LaTeX or the document itself was refused, so the pane has one thing to show.
 */

export function paperTemplates(): IpcResponse<'sheep:paper-templates'> {
  let available = true;
  let detail: string;
  try {
    const { versions } = getTools();
    detail = `Tectonic ${versions.tectonic}`;
  } catch (error) {
    available = false;
    detail = error instanceof Error ? error.message : String(error);
  }
  return {
    available,
    detail,
    templates: TEMPLATES.map(({ id, label, description }) => ({ id, label, description })),
  };
}

export async function compilePaper(
  request: IpcRequest<'sheep:paper-compile'>,
): Promise<IpcResponse<'sheep:paper-compile'>> {
  const store = getStore();
  const source = readPaperSource(store, request.sessionId);
  const document = buildDocument(source);

  try {
    const paper = await typesetPaper(
      document,
      templateById(request.template),
      getTools(),
      source.read,
    );
    return {
      ok: true,
      pdf: Buffer.from(paper.pdf).toString('base64'),
      bytes: paper.pdf.byteLength,
      claims: document.labels.length,
      figures: figuresIn(document).length,
      warnings: paper.warnings.map((warning) => ({ ...warning })),
    };
  } catch (error) {
    if (!(error instanceof LatexError)) throw error;
    return {
      ok: false,
      problems: error.problems
        .filter((problem) => problem.severity === 'error')
        .map((problem) => ({ ...problem })),
    };
  }
}

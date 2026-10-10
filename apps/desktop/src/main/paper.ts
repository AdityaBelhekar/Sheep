import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import type { IpcRequest, IpcResponse } from '@sheep/ipc';
import {
  buildPaper,
  bundleFiles,
  figuresIn,
  LatexError,
  ProvenanceError,
  TEMPLATES,
  zip,
  type BuiltPaper,
  type PaperSource,
} from '@sheep/paper';
import { getTools } from './artifacts';
import { readPaperSource, readSessionLog } from './paper-source';
import { isSmokeRun } from './smoke';
import { getStore } from './store';

/**
 * The Paper pane's side of the compiler: read the session, build the document,
 * typeset it, and hand over the bundle.
 *
 * A paper that is not compiled is an answer, not an error. The reply says what
 * is wrong — the engine refused a line, or a sentence asserts something with
 * no ledger claim behind it — in one shape, so the pane has one thing to show.
 */

type Request = IpcRequest<'sheep:paper-compile'>;
type Refusal = Extract<IpcResponse<'sheep:paper-compile'>, { ok: false }>;

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

/** Builds the paper, or says why there is none. Anything else that goes wrong is thrown. */
async function build(
  request: Request,
): Promise<{ source: PaperSource; paper: BuiltPaper } | Refusal> {
  const source = readPaperSource(getStore(), request.sessionId);
  try {
    const paper = await buildPaper(source, getTools(), {
      template: request.template,
      ...(request.omitUnprovenanced === undefined
        ? {}
        : { omitUnprovenanced: request.omitUnprovenanced }),
    });
    return { source, paper };
  } catch (error) {
    if (error instanceof ProvenanceError) {
      return {
        ok: false,
        problems: [],
        unprovenanced: error.sentences.map((sentence) => ({ ...sentence })),
      };
    }
    if (error instanceof LatexError) {
      return {
        ok: false,
        problems: error.problems
          .filter((problem) => problem.severity === 'error')
          .map((problem) => ({ ...problem })),
        unprovenanced: [],
      };
    }
    throw error;
  }
}

export async function compilePaper(request: Request): Promise<IpcResponse<'sheep:paper-compile'>> {
  const built = await build(request);
  if ('ok' in built) return built;
  const { paper } = built;
  return {
    ok: true,
    pdf: Buffer.from(paper.pdf).toString('base64'),
    bytes: paper.pdf.byteLength,
    claims: paper.document.labels.length,
    figures: figuresIn(paper.document).length,
    warnings: paper.warnings.map((warning) => ({ ...warning })),
    omitted: paper.omitted.map((sentence) => ({ ...sentence })),
  };
}

/**
 * Compiles the paper and saves its reproduction bundle where the person says.
 *
 * Compiled again rather than reusing what the pane last showed: the bundle is
 * of the ledger as it stands when it is exported, and its PDF, its LaTeX and
 * its event log are read at the same moment.
 */
export async function exportPaper(
  window: BrowserWindow,
  request: Request,
): Promise<IpcResponse<'sheep:paper-export'>> {
  const built = await build(request);
  if ('ok' in built) return built;
  const { source, paper } = built;

  const files = bundleFiles(source, paper.document, paper, paper.build, {
    log: readSessionLog(getStore(), request.sessionId),
    omitted: paper.omitted,
  });
  const archive = zip(files);
  const name = `sheep-record-${request.sessionId.slice(0, 8)}-${request.template}.zip`;

  // A launch check cannot answer a dialog; it gets the bundle in its own data directory.
  const path = isSmokeRun
    ? join(app.getPath('userData'), name)
    : (
        await dialog.showSaveDialog(window, {
          title: 'Export the reproduction bundle',
          defaultPath: join(app.getPath('documents'), name),
          filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
        })
      ).filePath;

  if (!path) return { ok: true, saved: false, path: null, files: files.length, bytes: 0 };
  writeFileSync(path, archive);
  return { ok: true, saved: true, path, files: files.length, bytes: archive.byteLength };
}

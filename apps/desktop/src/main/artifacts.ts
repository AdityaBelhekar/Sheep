import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import {
  locateTools,
  matplotlibScript,
  RenderError,
  renderFormula,
  renderGraphviz,
  renderTikz,
  type RenderTools,
  type Rendering,
} from '@sheep/artifacts';
import type { ArtifactKind, ArtifactRecord } from '@sheep/core';
import { getSession, recordArtifact, recordExecution, recordFigures } from '@sheep/store';
import type { MermaidPageReply } from '../shared/mermaid';
import { getSandbox } from './lab';
import { bundlePath, toolsPath } from './paths';
import { getStore } from './store';

/**
 * Main's side of artifacts: render a source, and write down what came out.
 *
 * An artifact is recorded only once every rendering of it exists, with its
 * source, so there is never a picture in the store that nothing can explain.
 */

let tools: RenderTools | undefined;

/** Located on first use: missing tools should not stop the app from opening. */
export function getTools(): RenderTools {
  tools ??= locateTools(toolsPath());
  return tools;
}

/** How long a diagram gets to load Mermaid, lay out and print. */
const MERMAID_TIMEOUT_MS = 60_000;

/**
 * Chromium stamps every PDF it prints with the moment it printed it, twice.
 * Both are rewritten to the fixed instant every other renderer uses, in place
 * and at the same length, so the file's internal offsets still hold.
 */
const PDF_DATE = /\/(CreationDate|ModDate) \(D:\d{14}[^)]*\)/g;
const FIXED_PDF_DATE = "D:20000101000000+00'00'";

function withFixedDates(pdf: Buffer): Buffer {
  // latin1 maps every byte to one character and back, so nothing else moves.
  const text = pdf.toString('latin1').replace(PDF_DATE, (stamp, key: string) => {
    const fixed = `/${key} (${FIXED_PDF_DATE})`;
    return fixed.length === stamp.length ? fixed : stamp;
  });
  return Buffer.from(text, 'latin1');
}

/**
 * Renders a Mermaid diagram in a window nobody sees.
 *
 * Mermaid needs a browser to measure text, and this is one. The page lays the
 * diagram out and returns the SVG; the same page, now showing only that SVG
 * on a sheet exactly its size, is printed for the PDF.
 *
 * ponytail: a fresh window per diagram, about half a second each. Keep one
 * open if diagrams are ever rendered in bulk.
 */
export async function renderMermaid(source: string): Promise<Rendering> {
  const window = new BrowserWindow({
    show: false,
    width: 1600,
    height: 1200,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // The page has no reason to open, or go, anywhere.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RenderError(`mermaid did not finish in ${String(MERMAID_TIMEOUT_MS)}ms`));
    }, MERMAID_TIMEOUT_MS);
  });

  const render = async (): Promise<Rendering> => {
    const devServer = process.env['ELECTRON_RENDERER_URL'];
    if (devServer) await window.loadURL(`${devServer}/mermaid.html`);
    else await window.loadFile(bundlePath('renderer', 'mermaid.html'));

    const reply = (await window.webContents.executeJavaScript(
      `window.renderMermaid(${JSON.stringify(source)})`,
    )) as MermaidPageReply;
    if (!reply.ok) throw new RenderError(reply.error);

    const pdf = await window.webContents.printToPDF({
      preferCSSPageSize: true,
      printBackground: true,
    });
    return {
      outputs: [
        { path: 'diagram.svg', data: Buffer.from(reply.svg, 'utf8') },
        { path: 'diagram.pdf', data: withFixedDates(pdf) },
      ],
      toolchain: `mermaid ${reply.version} · chromium ${process.versions.chrome}`,
    };
  };

  try {
    return await Promise.race([render(), timeout]);
  } finally {
    clearTimeout(timer);
    window.destroy();
  }
}

/**
 * A source rendered by a tool. Throws `RenderError` in the tool's own words.
 *
 * Every kind but `matplotlib`: a figure from the sandbox is not rendered from
 * its source by anything here, it is drawn by a run, and a run is recorded.
 */
export async function renderArtifact(
  kind: Exclude<ArtifactKind, 'matplotlib'>,
  source: string,
): Promise<Rendering> {
  switch (kind) {
    case 'formula':
      return renderFormula(getTools(), source);
    case 'graphviz':
      return renderGraphviz(getTools(), source);
    case 'mermaid':
      return renderMermaid(source);
    case 'tikz':
      return renderTikz(getTools(), source);
  }
}

export interface ArtifactRequest {
  readonly sessionId: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly source: string;
}

/** How much of a traceback is worth showing: the end, where the error is. */
const TRACEBACK_LINES = 12;

/**
 * Runs a plotting script in the sandbox and records what it drew.
 *
 * The run is recorded first and whatever happened to it, as every run is; the
 * figures are then recorded against it. So a figure made here can back an
 * `EMPIRICAL` claim like any other result — there is an execution behind it.
 */
async function drawFigures(request: ArtifactRequest): Promise<ArtifactRecord[]> {
  const store = getStore();
  const code = matplotlibScript(request.source);
  const run = await getSandbox().run({ code });
  try {
    const execution = await recordExecution(store, request.sessionId, code, run);
    if (execution.status !== 'ok') {
      const traceback = run.stderr.trim().split('\n').slice(-TRACEBACK_LINES).join('\n');
      throw new RenderError(traceback || run.detail || `the script ended as ${run.status}`);
    }
    const figures = recordFigures(store, execution, (stem) =>
      stem === 'figure-1' ? request.title : `${request.title} · ${stem}`,
    );
    if (figures.length === 0) throw new RenderError('the script ran, but drew no figure');
    return figures;
  } finally {
    run.dispose();
  }
}

/**
 * Renders a source and records the result as an artifact of the session.
 *
 * More than one comes back only for a script that drew more than one figure.
 */
export async function createArtifact(request: ArtifactRequest): Promise<ArtifactRecord[]> {
  const store = getStore();
  if (!getSession(store.db, request.sessionId)) {
    throw new Error(`unknown session: ${request.sessionId}`);
  }
  if (request.kind === 'matplotlib') return drawFigures(request);

  const rendering = await renderArtifact(request.kind, request.source);
  return [
    recordArtifact(store, request.sessionId, {
      artifactId: randomUUID(),
      kind: request.kind,
      title: request.title,
      source: request.source,
      outputs: rendering.outputs,
      toolchain: rendering.toolchain,
    }),
  ];
}

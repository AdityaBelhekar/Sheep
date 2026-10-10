import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { domainEvent, type ArtifactKind, type ArtifactRecord } from '@sheep/core';
import {
  claimsOnArtifacts,
  getArtifact,
  getExecution,
  getSession,
  listArtifacts,
  readLedger,
  recordArtifact,
  recordExecution,
  recordFigures,
  regenerateArtifact,
  type Regeneration,
} from '@sheep/store';
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

export function artifactsStatus(): { available: boolean; detail: string } {
  try {
    const { versions } = getTools();
    return {
      available: true,
      detail: `Graphviz ${versions.graphviz} · Tectonic ${versions.tectonic}`,
    };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  }
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

/** A session's artifacts, newest first, and the claims that rest on each. */
export function readArtifacts(sessionId: string): {
  artifacts: ArtifactRecord[];
  backing: { artifactId: string; claimIds: string[] }[];
} {
  const store = getStore();
  const artifacts = listArtifacts(store.db, sessionId);
  const backing = claimsOnArtifacts(readLedger(store.events, sessionId), artifacts);
  return {
    artifacts,
    backing: [...backing].map(([artifactId, claimIds]) => ({ artifactId, claimIds })),
  };
}

/**
 * Attaches a figure to a claim as evidence.
 *
 * Through the ledger like any other evidence, so a figure that does not exist
 * or a claim that is closed is refused with the rule it broke.
 */
export function linkArtifact(sessionId: string, artifactId: string, claimId: string): void {
  getStore().record([
    domainEvent('claim.evidence-attached', {
      sessionId,
      claimId,
      evidence: { kind: 'ARTIFACT', ref: artifactId },
    }),
  ]);
}

export interface Rerendering extends Regeneration {
  /** What rendered it then, and what would render it now. */
  readonly toolchain: { readonly recorded: string; readonly current: string };
}

/** Draws a sandbox figure's script again, under the seed and limits of the run that drew it. */
async function redrawFigures(artifact: ArtifactRecord, code: string): Promise<Rendering> {
  const execution =
    artifact.executionId === null ? undefined : getExecution(getStore().db, artifact.executionId);
  if (!execution) throw new Error(`artifact ${artifact.artifactId} names no recorded run`);

  const sandbox = getSandbox();
  // A check, not a result: this run is compared against the record, not added to it.
  const run = await sandbox.run({ code, seed: execution.seed, limits: execution.limits });
  try {
    if (run.status !== 'ok') {
      throw new RenderError(run.stderr.trim() || run.detail || `the script ended as ${run.status}`);
    }
    return {
      outputs: run.artifacts.map(({ path }) => ({
        path,
        data: readFileSync(join(run.workDir, path)),
      })),
      toolchain: `sandbox python · lock ${sandbox.runtime.lockHash.slice(0, 12)}`,
    };
  } finally {
    run.dispose();
  }
}

/**
 * Renders an artifact again from its stored source and sets the result against
 * the record (P5).
 *
 * Nothing but the source is read: the recorded renderings could all be gone
 * and this would still say what they were, and put back each one that comes
 * out the same. When they do not come out the same, the two toolchains are
 * there to say whether that was to be expected.
 */
export async function rerenderArtifact(artifactId: string): Promise<Rerendering> {
  const store = getStore();
  const artifact = getArtifact(store.db, artifactId);
  if (!artifact) throw new Error(`unknown artifact: ${artifactId}`);

  const source = store.blobs.readText(artifact.sourceHash);
  const rendering =
    artifact.kind === 'matplotlib'
      ? await redrawFigures(artifact, source)
      : await renderArtifact(artifact.kind, source);
  return {
    ...regenerateArtifact(store, artifact, rendering.outputs),
    toolchain: { recorded: artifact.toolchain, current: rendering.toolchain },
  };
}

/** The most of one blob the renderer is sent. Figures are far smaller. */
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

export function readArtifactBlob(request: { artifactId: string; hash: string }): {
  base64: string;
  bytes: number;
  truncated: boolean;
} {
  const store = getStore();
  const artifact = getArtifact(store.db, request.artifactId);
  if (!artifact) throw new Error(`unknown artifact: ${request.artifactId}`);

  const owned = new Set([artifact.sourceHash, ...artifact.outputs.map((output) => output.hash)]);
  if (!owned.has(request.hash)) {
    throw new Error(`artifact ${request.artifactId} holds no blob ${request.hash}`);
  }
  const bytes = store.blobs.read(request.hash);
  return {
    base64: Buffer.from(bytes.subarray(0, MAX_BLOB_BYTES)).toString('base64'),
    bytes: bytes.byteLength,
    truncated: bytes.byteLength > MAX_BLOB_BYTES,
  };
}

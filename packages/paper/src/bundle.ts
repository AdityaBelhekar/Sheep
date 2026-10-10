// The ambient declaration has to travel with this file into other packages' programs.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./raw.d.ts" />
import { formulaDocument, tikzDocument } from '@sheep/artifacts';
import type { ArtifactKind } from '@sheep/core';
import { zip } from '@sheep/store';
import reproduceScript from '../python/reproduce.py?raw';
import type { PaperFile } from './compile';
import { figuresIn, type PaperDocument, type PaperSource } from './ir';
import type { BuildFacts, Unprovenanced } from './provenance';

/**
 * The reproduction bundle: the paper, and everything needed to check it.
 *
 * One archive holding the PDF, the LaTeX it was compiled from, the source of
 * every figure, the session's event log, and a script that draws each figure
 * again from that source and compares the result with the hash the paper
 * recorded (P5). The figures are in the bundle, but the script never reads
 * them: what it reports as identical was made from scratch.
 */

// Written by the store's archive writer: one fixed timestamp, entries in order, so the
// same files are the same bundle byte for byte.
export { zip };

/** One entry of the session's event log, as the store holds it. */
export interface LoggedEvent {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly recordedAt: string;
  readonly payloadHash: string;
  readonly prevHash: string;
  readonly entryHash: string;
}

const SOURCE_EXTENSION: Readonly<Record<ArtifactKind, string>> = {
  formula: 'tex',
  graphviz: 'dot',
  matplotlib: 'py',
  mermaid: 'mmd',
  tikz: 'tex',
};

/**
 * A figure's source as the reproduction script is given it.
 *
 * A TikZ picture and a formula are stored as the fragment their author wrote;
 * what the engine typeset was that fragment inside a document. The bundle
 * carries the document, so the script has nothing to know about wrapping.
 */
function reproducibleSource(kind: ArtifactKind, source: string): string {
  if (kind === 'tikz') return tikzDocument(source);
  if (kind === 'formula') return formulaDocument(source);
  return source;
}

const README = (document: PaperDocument, build: BuildFacts): string =>
  [
    `Sheep Research Record — ${document.title}`,
    '',
    `Session ${document.sessionId}, compiled in the ${build.template} template.`,
    '',
    'paper.pdf       the paper',
    'paper.tex       the LaTeX it was compiled from, with every claim id in the source',
    'figures/        the figures as the paper includes them',
    'sources/        the source each figure was rendered from',
    'manifest.json   every figure with its source, tool, seed and recorded hashes;',
    '                the event-log root hash; anything left out of the paper',
    'events.jsonl    the session event log, one entry per line, with its hashes',
    'reproduce.py    draws every figure again from sources/ and compares the hashes',
    '',
    'To check the figures:',
    '',
    '    python reproduce.py --dot <path to dot> --tectonic <path to tectonic>',
    '',
    'with a Python that has the packages the session ran with. Identical bytes need',
    'the same tool versions; manifest.json names them.',
    '',
  ].join('\n');

/**
 * Every file of the bundle, ready to be zipped.
 *
 * `compiled` is exactly what the engine was given, and is included as it
 * stands: the bundle's paper.tex is the one the bundle's paper.pdf came from.
 */
export function bundleFiles(
  source: PaperSource,
  document: PaperDocument,
  paper: { readonly pdf: Uint8Array; readonly files: readonly PaperFile[] },
  build: BuildFacts,
  extra: { readonly log: readonly LoggedEvent[]; readonly omitted: readonly Unprovenanced[] },
): PaperFile[] {
  const labelOf = new Map(document.labels.map((entry) => [entry.claimId, entry.label]));
  const sources: PaperFile[] = [];
  const figures = figuresIn(document).map((figure, index) => {
    const found = source.artifacts.find((entry) => entry.record.artifactId === figure.artifactId);
    if (!found) throw new Error(`the paper includes an artifact the session does not hold`);
    const { record, claimIds } = found;
    const run = source.executions.find((entry) => entry.executionId === record.executionId);

    const path = `sources/figure-${String(index + 1)}.${SOURCE_EXTENSION[record.kind]}`;
    sources.push({
      path,
      data: reproducibleSource(
        record.kind,
        Buffer.from(source.read(record.sourceHash)).toString('utf8'),
      ),
    });
    return {
      file: figure.file,
      artifactId: record.artifactId,
      kind: record.kind,
      title: record.title,
      source: path,
      toolchain: record.toolchain,
      ...(run
        ? { seed: run.seed, envLockHash: run.envLockHash, executionId: run.executionId }
        : {}),
      // Every rendering the artifact recorded, not only the one the paper includes.
      outputs: record.outputs.map((output) => ({ path: output.path, sha256: output.hash })),
      claims: claimIds.map((claimId) => ({ claimId, label: labelOf.get(claimId) ?? null })),
    };
  });

  const manifest = {
    format: 'sheep-research-record/1',
    sessionId: document.sessionId,
    title: document.title,
    question: document.question,
    template: build.template,
    engine: build.engine,
    toolsLockHash: build.toolsLockHash,
    eventLog: {
      entries: extra.log.length,
      headSeq: source.head?.seq ?? null,
      rootHash: source.head?.entryHash ?? null,
    },
    claims: document.labels,
    figures,
    omitted: extra.omitted,
  };

  return [
    { path: 'README.txt', data: README(document, build) },
    { path: 'paper.pdf', data: paper.pdf },
    ...paper.files,
    ...sources,
    { path: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` },
    {
      path: 'events.jsonl',
      data: extra.log.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
    },
    { path: 'reproduce.py', data: reproduceScript },
  ];
}

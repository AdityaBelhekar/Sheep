import { randomUUID } from 'node:crypto';
import {
  domainEvent,
  type ArtifactKind,
  type ArtifactRecord,
  type ExecutionArtifact,
  type ExecutionRecord,
} from '@sheep/core';
import type { BlobRef } from './cas/blob-store';
import { getArtifact } from './projections/artifacts';
import type { SheepStore } from './store';

/**
 * An artifact as its renderer hands it over: the source it was made from and
 * the bytes of every file that came out.
 *
 * Declared here rather than imported: the store does not depend on any
 * renderer, and anything shaped like this can be recorded.
 */
export interface RenderedArtifact {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly source: string;
  readonly outputs: readonly { readonly path: string; readonly data: Uint8Array }[];
  readonly toolchain: string;
  /** The run that drew it, for a figure from the sandbox. */
  readonly executionId?: string;
}

/** Who holds an artifact's blobs. Releasing it frees them for collection. */
export function artifactBlobRef(artifactId: string): BlobRef {
  return { kind: 'artifact', id: artifactId };
}

/**
 * Makes a rendered artifact permanent: its source and every rendering go into
 * the content-addressed store, and one `artifact.recorded` event names them
 * all by hash.
 *
 * The same order and the same rollback as an execution record: bytes before
 * the event, so the log never names a blob that is not there, and released
 * again if the event is refused.
 */
export function recordArtifact(
  store: SheepStore,
  sessionId: string,
  artifact: RenderedArtifact,
): ArtifactRecord {
  const { artifactId } = artifact;
  // Checked before anything is stored: the rollback below releases whatever
  // this id holds, which must never be an earlier artifact's blobs.
  if (getArtifact(store.db, artifactId)) {
    throw new Error(`artifact ${artifactId} is already recorded`);
  }

  const ref = artifactBlobRef(artifactId);
  try {
    store.record([
      domainEvent('artifact.recorded', {
        sessionId,
        artifactId,
        kind: artifact.kind,
        title: artifact.title,
        sourceHash: store.blobs.put(artifact.source, ref).hash,
        outputs: artifact.outputs.map(({ path, data }) => {
          const blob = store.blobs.put(data, ref);
          return { path, hash: blob.hash, bytes: blob.bytes };
        }),
        toolchain: artifact.toolchain,
        ...(artifact.executionId === undefined ? {} : { executionId: artifact.executionId }),
      }),
    ]);
  } catch (error) {
    store.blobs.releaseAll(ref);
    throw error;
  }

  const recorded = getArtifact(store.db, artifactId);
  if (!recorded) throw new Error(`artifact ${artifactId} was recorded but not projected`);
  return recorded;
}

/** What a figure is saved as, in the order a reader is offered them. */
const FIGURE_FORMATS = ['svg', 'pdf', 'png'];

/**
 * The figures among a run's files: `plots/loss.svg` and `plots/loss.pdf` are
 * one figure, `plots/loss`, in two formats. A CSV beside them is not one.
 */
function figuresOf(artifacts: readonly ExecutionArtifact[]): Map<string, ExecutionArtifact[]> {
  const figures = new Map<string, ExecutionArtifact[]>();
  for (const format of FIGURE_FORMATS) {
    for (const artifact of artifacts) {
      if (!artifact.path.toLowerCase().endsWith(`.${format}`)) continue;
      const stem = artifact.path.slice(0, -format.length - 1);
      figures.set(stem, [...(figures.get(stem) ?? []), artifact]);
    }
  }
  return figures;
}

/**
 * Records every figure a clean sandbox run left behind as an artifact.
 *
 * The run already is the figure's provenance — its code is the source, its
 * seed and environment lock are what make it repeatable — so the artifact
 * stores nothing new. It names the run and takes its own hold on the same
 * blobs, so that it outlives nothing it depends on.
 *
 * A failed run's files are not figures: what a script drew before it crashed
 * is not something to put in a paper.
 */
export function recordFigures(
  store: SheepStore,
  execution: ExecutionRecord,
  /** Names a figure, given its path without the extension. Defaults to that path. */
  titleOf: (stem: string) => string = (stem) => stem,
): ArtifactRecord[] {
  if (execution.status !== 'ok') return [];

  return [...figuresOf(execution.artifacts)].map(([stem, outputs]) => {
    const artifactId = randomUUID();
    const ref = artifactBlobRef(artifactId);
    try {
      for (const hash of [execution.codeHash, ...outputs.map((output) => output.hash)]) {
        store.blobs.retain(hash, ref);
      }
      store.record([
        domainEvent('artifact.recorded', {
          sessionId: execution.sessionId,
          artifactId,
          kind: 'matplotlib',
          title: titleOf(stem).slice(0, 200),
          sourceHash: execution.codeHash,
          outputs,
          toolchain: `sandbox python · lock ${execution.envLockHash.slice(0, 12)}`,
          executionId: execution.executionId,
        }),
      ]);
    } catch (error) {
      store.blobs.releaseAll(ref);
      throw error;
    }

    const recorded = getArtifact(store.db, artifactId);
    if (!recorded) throw new Error(`artifact ${artifactId} was recorded but not projected`);
    return recorded;
  });
}

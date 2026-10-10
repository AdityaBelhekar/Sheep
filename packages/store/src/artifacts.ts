import { domainEvent, type ArtifactKind, type ArtifactRecord } from '@sheep/core';
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

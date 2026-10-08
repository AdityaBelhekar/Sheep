import { join } from 'node:path';
import {
  domainEvent,
  LedgerError,
  type ExecutionArtifact,
  type ExecutionLimits,
  type ExecutionRecord,
  type ExecutionStatus,
} from '@sheep/core';
import type { BlobRef } from './cas/blob-store';
import { getExecution } from './projections/executions';
import type { SheepStore } from './store';

/**
 * A finished sandbox run, as the sandbox reports it.
 *
 * Declared here rather than imported: the store does not depend on the
 * sandbox, and anything shaped like this can be recorded.
 */
export interface FinishedRun {
  readonly executionId: string;
  readonly status: ExecutionStatus;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly seed: number;
  readonly envLockHash: string;
  readonly limits: ExecutionLimits;
  readonly peakMemoryBytes: number | null;
  /** Paths relative to `workDir`. */
  readonly artifacts: readonly { readonly path: string }[];
  /** Where the artifact files still are. */
  readonly workDir: string;
}

/** Who holds an execution's blobs. Releasing it frees them for collection. */
export function executionBlobRef(executionId: string): BlobRef {
  return { kind: 'execution', id: executionId };
}

/**
 * Makes a run permanent: its code, both streams and every file it produced go
 * into the content-addressed store, and one `execution.recorded` event names
 * them all by hash.
 *
 * The bytes are stored before the event is appended, so the log never names a
 * blob that is not there. If the event is refused the blobs are released
 * again, and the next collection takes them — nothing is left held by a run
 * the log does not know about.
 */
export async function recordExecution(
  store: SheepStore,
  sessionId: string,
  code: string,
  run: FinishedRun,
): Promise<ExecutionRecord> {
  // Checked before anything is stored: the rollback below releases whatever
  // this id holds, which must never be an earlier run's blobs.
  if (getExecution(store.db, run.executionId)) {
    throw new LedgerError(
      'DUPLICATE_EXECUTION',
      `execution ${run.executionId} is already recorded`,
    );
  }

  const ref = executionBlobRef(run.executionId);
  try {
    const artifacts: ExecutionArtifact[] = [];
    for (const artifact of run.artifacts) {
      // Hashed by the store as it is copied in: the address is of the bytes
      // that were actually kept, not of what something earlier said they were.
      const blob = await store.blobs.putFile(join(run.workDir, artifact.path), ref);
      artifacts.push({ path: artifact.path, hash: blob.hash, bytes: blob.bytes });
    }

    store.record([
      domainEvent('execution.recorded', {
        sessionId,
        executionId: run.executionId,
        codeHash: store.blobs.put(code, ref).hash,
        exitCode: run.exitCode,
        status: run.status,
        seed: run.seed,
        envLockHash: run.envLockHash,
        limits: run.limits,
        durationMs: run.durationMs,
        stdoutHash: store.blobs.put(run.stdout, ref).hash,
        stderrHash: store.blobs.put(run.stderr, ref).hash,
        truncated: run.truncated,
        artifacts,
        ...(run.peakMemoryBytes === null ? {} : { peakMemoryBytes: run.peakMemoryBytes }),
      }),
    ]);
  } catch (error) {
    store.blobs.releaseAll(ref);
    throw error;
  }

  const recorded = getExecution(store.db, run.executionId);
  if (!recorded) throw new Error(`execution ${run.executionId} was recorded but not projected`);
  return recorded;
}

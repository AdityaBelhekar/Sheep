import { z } from 'zod';
import { byteCountSchema, idSchema, sha256Schema, timestampSchema } from './primitives';

/**
 * A run the sandbox performed, recorded so that it can be performed again.
 *
 * Everything needed to repeat it is here or one content address away: the code
 * by hash, the seed, the limits it was held to, and the lock hash naming the
 * interpreter and wheels. Everything it produced is here the same way — both
 * streams and every file it left behind, by hash. An `EMPIRICAL` claim points
 * at one of these (P2), which is what makes a result a hashed artifact rather
 * than something a model said.
 *
 * Failed runs are recorded too. What ran is history whether or not it worked;
 * the ledger is what refuses to let a failed run back a claim.
 */

export const EXECUTION_STATUSES = ['ok', 'error', 'timeout', 'cancelled', 'crashed'] as const;
export const executionStatusSchema = z.enum(EXECUTION_STATUSES);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const executionLimitsSchema = z.strictObject({
  memoryMb: z.number().int().positive(),
  cpuPercent: z.number().int().min(1).max(100),
  timeoutMs: z.number().int().positive(),
});
export type ExecutionLimits = z.infer<typeof executionLimitsSchema>;

export const executionArtifactSchema = z.strictObject({
  /** Relative to the run's working directory, forward slashes. */
  path: z.string().min(1).max(1_024),
  hash: sha256Schema,
  bytes: byteCountSchema,
});
export type ExecutionArtifact = z.infer<typeof executionArtifactSchema>;

/** What a run was and what it did. Shared by the event and the projected row. */
export const executionFields = {
  executionId: idSchema,
  codeHash: sha256Schema,
  /** The script's own exit code; -1 when it was stopped rather than exiting. */
  exitCode: z.number().int(),
  status: executionStatusSchema,
  seed: z.number().int().min(0).max(0xffff_ffff),
  /** Which interpreter and wheels: the runtime's lock hash. */
  envLockHash: sha256Schema,
  limits: executionLimitsSchema,
  durationMs: z.number().int().nonnegative(),
  stdoutHash: sha256Schema,
  stderrHash: sha256Schema,
  /** True when output past the relay cap was dropped before it was stored. */
  truncated: z.boolean(),
  artifacts: z.array(executionArtifactSchema),
} as const;

export const executionRecordSchema = z.strictObject({
  sessionId: idSchema,
  ...executionFields,
  /** Largest committed memory of any one process in the run; null when unknown. */
  peakMemoryBytes: byteCountSchema.nullable(),
  recordedAt: timestampSchema,
});
export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

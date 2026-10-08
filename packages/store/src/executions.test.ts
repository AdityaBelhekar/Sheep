import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { domainEvent } from '@sheep/core';
import { CLAIM_ID, EXECUTION_ID, SESSION_ID } from '@sheep/core/fixtures';
import { executionBlobRef, recordExecution, type FinishedRun } from './executions';
import { readLedger } from './ledger';
import { getExecution, listExecutions } from './projections/executions';
import { openSheepStore, type SheepStore } from './store';
import { TESTABLE_DRIVERS, useTempDir } from './test-support';

const tempDir = useTempDir('sheep-executions-');

const CODE = 'print("0.3 nats")\n';
const OTHER_EXECUTION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';

/** A run that left one figure in a nested directory, as the sandbox would report it. */
function finishedRun(dir: string, overrides: Partial<FinishedRun> = {}): FinishedRun {
  const workDir = join(dir, 'work');
  mkdirSync(join(workDir, 'figures'), { recursive: true });
  writeFileSync(join(workDir, 'figures', 'plot.png'), 'not really a png');
  return {
    executionId: EXECUTION_ID,
    status: 'ok',
    exitCode: 0,
    durationMs: 412,
    stdout: '0.3 nats\n',
    stderr: '',
    truncated: false,
    seed: 7,
    envLockHash: 'a'.repeat(64),
    limits: { memoryMb: 1024, cpuPercent: 50, timeoutMs: 60_000 },
    peakMemoryBytes: 31_000_000,
    artifacts: [{ path: 'figures/plot.png' }],
    workDir,
    ...overrides,
  };
}

function withSession(dir: string, driver: (typeof TESTABLE_DRIVERS)[number]): SheepStore {
  const store = openSheepStore({ dataDir: dir, driver });
  store.record([
    domainEvent('session.created', {
      sessionId: SESSION_ID,
      title: 'Sparse attention',
      question: 'Does block-sparse attention preserve perplexity?',
    }),
  ]);
  return store;
}

describe.each(TESTABLE_DRIVERS)('execution records on %s', (driver) => {
  it('persists code, streams and artifacts by content address', async () => {
    const dir = tempDir();
    const store = withSession(dir, driver);
    try {
      const record = await recordExecution(store, SESSION_ID, CODE, finishedRun(dir));

      expect(record).toMatchObject({
        sessionId: SESSION_ID,
        executionId: EXECUTION_ID,
        status: 'ok',
        exitCode: 0,
        seed: 7,
        envLockHash: 'a'.repeat(64),
        limits: { memoryMb: 1024, cpuPercent: 50, timeoutMs: 60_000 },
        peakMemoryBytes: 31_000_000,
        truncated: false,
      });
      expect(store.blobs.readText(record.codeHash)).toBe(CODE);
      expect(store.blobs.readText(record.stdoutHash)).toBe('0.3 nats\n');
      expect(store.blobs.readText(record.stderrHash)).toBe('');
      expect(record.artifacts).toHaveLength(1);
      expect(record.artifacts[0]).toMatchObject({ path: 'figures/plot.png', bytes: 16 });
      expect(store.blobs.readText(record.artifacts[0]!.hash)).toBe('not really a png');

      expect(getExecution(store.db, EXECUTION_ID)).toEqual(record);
      expect(listExecutions(store.db, SESSION_ID)).toEqual([record]);
    } finally {
      store.close();
    }
  });

  it('holds every blob against collection for as long as the execution does', async () => {
    const dir = tempDir();
    const store = withSession(dir, driver);
    try {
      const record = await recordExecution(store, SESSION_ID, CODE, finishedRun(dir));
      const hashes = [
        record.codeHash,
        record.stdoutHash,
        record.stderrHash,
        ...record.artifacts.map((artifact) => artifact.hash),
      ];

      expect(store.blobs.gc().removed).toEqual([]);
      expect(new Set(store.blobs.heldBy(executionBlobRef(EXECUTION_ID)))).toEqual(new Set(hashes));
    } finally {
      store.close();
    }
  });

  it('lets an empirical claim rest on a recorded run, and only a clean one', async () => {
    const dir = tempDir();
    const store = withSession(dir, driver);
    const claim = (ref: string, claimId = CLAIM_ID) =>
      domainEvent('claim.recorded', {
        sessionId: SESSION_ID,
        claimId,
        claimType: 'EMPIRICAL',
        statement: 'Perplexity rises 0.3 nats at 128k context.',
        support: [{ kind: 'EXECUTION', ref }],
      });
    try {
      await recordExecution(store, SESSION_ID, CODE, finishedRun(dir));
      await recordExecution(
        store,
        SESSION_ID,
        CODE,
        finishedRun(dir, { executionId: OTHER_EXECUTION, status: 'timeout', exitCode: -1 }),
      );

      store.record([claim(EXECUTION_ID)]);
      expect(readLedger(store.events, SESSION_ID).claim(CLAIM_ID).support).toEqual([
        { kind: 'EXECUTION', ref: EXECUTION_ID },
      ]);
      expect(() => store.record([claim(OTHER_EXECUTION, OTHER_EXECUTION)])).toThrow(
        /LEDGER_FAILED_EXECUTION/,
      );
      // The failed run is still history: recorded, listed, newest first.
      expect(listExecutions(store.db, SESSION_ID).map((run) => run.status)).toEqual([
        'timeout',
        'ok',
      ]);
    } finally {
      store.close();
    }
  });

  it('leaves nothing held when the event is refused', async () => {
    const dir = tempDir();
    const store = withSession(dir, driver);
    try {
      const events = store.events.count();

      // A run that claims a clean status with a failing exit code.
      await expect(
        recordExecution(store, SESSION_ID, CODE, finishedRun(dir, { exitCode: 1 })),
      ).rejects.toThrow(/LEDGER_INCONSISTENT_EXECUTION/);

      expect(store.events.count()).toBe(events);
      expect(store.blobs.heldBy(executionBlobRef(EXECUTION_ID))).toEqual([]);
      expect(store.blobs.gc().keptCount).toBe(0);
    } finally {
      store.close();
    }
  });

  it('refuses a second run under the same id without touching the first', async () => {
    const dir = tempDir();
    const store = withSession(dir, driver);
    try {
      const first = await recordExecution(store, SESSION_ID, CODE, finishedRun(dir));
      const held = store.blobs.heldBy(executionBlobRef(EXECUTION_ID));

      await expect(
        recordExecution(store, SESSION_ID, CODE, finishedRun(dir, { stdout: 'something else\n' })),
      ).rejects.toThrow(/LEDGER_DUPLICATE_EXECUTION/);

      expect(getExecution(store.db, EXECUTION_ID)).toEqual(first);
      expect(store.blobs.heldBy(executionBlobRef(EXECUTION_ID))).toEqual(held);
      expect(store.blobs.readText(first.stdoutHash)).toBe('0.3 nats\n');
    } finally {
      store.close();
    }
  });

  it('rebuilds the executions table from the log alone', async () => {
    const dir = tempDir();
    const store = withSession(dir, driver);
    try {
      const record = await recordExecution(store, SESSION_ID, CODE, finishedRun(dir));
      store.db.exec('DROP TABLE executions');
      store.projections.ensure();

      expect(listExecutions(store.db, SESSION_ID)).toEqual([record]);
    } finally {
      store.close();
    }
  });
});

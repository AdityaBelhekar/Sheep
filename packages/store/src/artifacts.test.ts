import { describe, expect, it } from 'vitest';
import { domainEvent } from '@sheep/core';
import { ARTIFACT_ID, EXECUTION_ID, SESSION_ID } from '@sheep/core/fixtures';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactBlobRef, recordArtifact, recordFigures, type RenderedArtifact } from './artifacts';
import { executionBlobRef, recordExecution, type FinishedRun } from './executions';
import { getArtifact, listArtifacts } from './projections/artifacts';
import { openSheepStore, type SheepStore } from './store';
import { TESTABLE_DRIVERS, useTempDir } from './test-support';

const tempDir = useTempDir('sheep-artifacts-');

const DOT = 'digraph { claim -> evidence }\n';

const CODE = 'plt.plot(losses)';

/** A run that left two figures and a table, as the sandbox would report it. */
function finishedRun(dir: string, overrides: Partial<FinishedRun> = {}): FinishedRun {
  const workDir = join(dir, 'work');
  mkdirSync(join(workDir, 'plots'), { recursive: true });
  const files = ['overview.png', 'plots/loss.pdf', 'plots/loss.svg', 'plots/loss.csv'];
  for (const file of files) writeFileSync(join(workDir, file), `bytes of ${file}`);
  return {
    executionId: EXECUTION_ID,
    status: 'ok',
    exitCode: 0,
    durationMs: 412,
    stdout: '',
    stderr: '',
    truncated: false,
    seed: 7,
    envLockHash: 'a'.repeat(64),
    limits: { memoryMb: 1024, cpuPercent: 50, timeoutMs: 60_000 },
    peakMemoryBytes: null,
    artifacts: files.map((path) => ({ path })),
    workDir,
    ...overrides,
  };
}

const rendered = (overrides: Partial<RenderedArtifact> = {}): RenderedArtifact => ({
  artifactId: ARTIFACT_ID,
  kind: 'graphviz',
  title: 'What rests on what',
  source: DOT,
  outputs: [
    { path: 'diagram.svg', data: Buffer.from('<svg/>') },
    { path: 'diagram.pdf', data: Buffer.from('%PDF-1.7 not really') },
  ],
  toolchain: 'graphviz 16.1.0',
  ...overrides,
});

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

describe.each(TESTABLE_DRIVERS)('artifact records on %s', (driver) => {
  it('persists the source and every rendering by content address', () => {
    const store = withSession(tempDir(), driver);
    try {
      const record = recordArtifact(store, SESSION_ID, rendered());

      expect(record).toMatchObject({
        sessionId: SESSION_ID,
        artifactId: ARTIFACT_ID,
        kind: 'graphviz',
        title: 'What rests on what',
        toolchain: 'graphviz 16.1.0',
        executionId: null,
      });
      expect(store.blobs.readText(record.sourceHash)).toBe(DOT);
      expect(record.outputs.map(({ path, bytes }) => [path, bytes])).toEqual([
        ['diagram.svg', 6],
        ['diagram.pdf', 19],
      ]);
      expect(store.blobs.readText(record.outputs[0]!.hash)).toBe('<svg/>');
      expect(listArtifacts(store.db, SESSION_ID)).toEqual([record]);
      // Held against collection for as long as the record stands.
      expect(store.blobs.gc().removed).toEqual([]);
      expect(store.blobs.heldBy(artifactBlobRef(ARTIFACT_ID))).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it('refuses a second artifact under the same id without touching the first', () => {
    const store = withSession(tempDir(), driver);
    try {
      const first = recordArtifact(store, SESSION_ID, rendered());

      expect(() => recordArtifact(store, SESSION_ID, rendered({ source: 'graph {}' }))).toThrow(
        /already recorded/,
      );
      expect(getArtifact(store.db, ARTIFACT_ID)).toEqual(first);
      expect(store.blobs.readText(first.sourceHash)).toBe(DOT);
    } finally {
      store.close();
    }
  });

  it('leaves nothing held when the event is refused', () => {
    const store = withSession(tempDir(), driver);
    try {
      // An artifact with no rendering is not an artifact; the schema says so.
      expect(() => recordArtifact(store, SESSION_ID, rendered({ outputs: [] }))).toThrow();
      expect(store.blobs.heldBy(artifactBlobRef(ARTIFACT_ID))).toEqual([]);
      expect(listArtifacts(store.db, SESSION_ID)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('records the figures a clean run drew, and only those', async () => {
    const dir = tempDir();
    const store = withSession(dir, driver);
    try {
      const execution = await recordExecution(store, SESSION_ID, CODE, finishedRun(dir));
      const figures = recordFigures(store, execution);

      // Two figures in three files; the CSV beside them is data, not a figure.
      expect(figures.map((figure) => [figure.title, figure.outputs.map((o) => o.path)])).toEqual([
        ['plots/loss', ['plots/loss.svg', 'plots/loss.pdf']],
        ['overview', ['overview.png']],
      ]);
      for (const figure of figures) {
        expect(figure).toMatchObject({
          kind: 'matplotlib',
          sourceHash: execution.codeHash,
          executionId: EXECUTION_ID,
          toolchain: 'sandbox python · lock aaaaaaaaaaaa',
        });
      }
      expect(store.blobs.readText(figures[0]!.sourceHash)).toBe(CODE);

      // Each figure holds its own blobs: the run's record going away does not take them.
      store.blobs.releaseAll(executionBlobRef(EXECUTION_ID));
      store.blobs.gc();
      expect(figures.flatMap((f) => f.outputs).every((o) => store.blobs.has(o.hash))).toBe(true);
      expect(store.blobs.has(execution.codeHash)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('takes no figure from a run that failed', async () => {
    const dir = tempDir();
    const store = withSession(dir, driver);
    try {
      const failed = await recordExecution(
        store,
        SESSION_ID,
        CODE,
        finishedRun(dir, { status: 'error', exitCode: 1 }),
      );
      expect(recordFigures(store, failed)).toEqual([]);
      expect(listArtifacts(store.db, SESSION_ID)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('rebuilds the artifacts table from the log alone', () => {
    const store = withSession(tempDir(), driver);
    try {
      const record = recordArtifact(store, SESSION_ID, rendered());
      store.db.exec('DROP TABLE artifacts');
      store.projections.ensure();

      expect(listArtifacts(store.db, SESSION_ID)).toEqual([record]);
    } finally {
      store.close();
    }
  });
});

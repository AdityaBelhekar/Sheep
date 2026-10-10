import { describe, expect, it } from 'vitest';
import { domainEvent } from '@sheep/core';
import { ARTIFACT_ID, SESSION_ID } from '@sheep/core/fixtures';
import { artifactBlobRef, recordArtifact, type RenderedArtifact } from './artifacts';
import { getArtifact, listArtifacts } from './projections/artifacts';
import { openSheepStore, type SheepStore } from './store';
import { TESTABLE_DRIVERS, useTempDir } from './test-support';

const tempDir = useTempDir('sheep-artifacts-');

const DOT = 'digraph { claim -> evidence }\n';

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

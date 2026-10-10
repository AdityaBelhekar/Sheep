import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { domainEvent, type ArtifactKind } from '@sheep/core';
import { SESSION_ID } from '@sheep/core/fixtures';
import { openSheepStore, recordArtifact, regenerateArtifact } from '@sheep/store';
import { renderGraphviz, type Rendering } from './graphviz';
import { renderFormula, renderTikz } from './latex';
import { devToolsDir, locateTools } from './tools';

/**
 * The stage's promise, end to end with the real tools and a real store: delete
 * a figure, regenerate it from nothing but its recorded source, and get the
 * same file back.
 *
 * Mermaid and matplotlib make the same promise through a browser and the
 * sandbox; the app's launch check holds them to it.
 */
vi.setConfig({ testTimeout: 120_000 });

const tools = locateTools(devToolsDir());
const dataDir = mkdtempSync(join(tmpdir(), 'sheep-regeneration-'));
const store = openSheepStore({ dataDir });
store.record([
  domainEvent('session.created', {
    sessionId: SESSION_ID,
    title: 'Regeneration',
    question: 'Does a deleted figure come back the same?',
  }),
]);
afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const CASES: [ArtifactKind, string, (source: string) => Promise<Rendering>][] = [
  ['graphviz', 'digraph { source -> figure; figure -> claim }', (s) => renderGraphviz(tools, s)],
  ['tikz', '\\draw[->] (0,0) -- node[above] {backs} (3,0);', (s) => renderTikz(tools, s)],
  ['formula', 'H = -\\sum_i p_i \\log p_i', (s) => renderFormula(tools, s)],
];

describe('figure regeneration', () => {
  it.each(CASES)('brings a deleted %s figure back byte for byte', async (kind, source, render) => {
    const rendering = await render(source);
    const record = recordArtifact(store, SESSION_ID, {
      artifactId: randomUUID(),
      kind,
      title: `A ${kind} figure`,
      source,
      ...rendering,
    });

    // Every rendering is deleted. Only the source is left.
    const originals = record.outputs.map((output) => {
      const path = store.blobs.pathFor(output.hash);
      const bytes = readFileSync(path);
      rmSync(path);
      return { path, bytes };
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const again = await render(store.blobs.readText(record.sourceHash));
    const result = regenerateArtifact(store, record, again.outputs);

    expect(result.identical).toBe(true);
    expect(result.files.every((file) => file.restored)).toBe(true);
    expect(again.toolchain).toBe(record.toolchain);
    for (const { path, bytes } of originals) {
      expect(readFileSync(path).equals(bytes)).toBe(true);
    }
  });
});

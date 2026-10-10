import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { devToolsDir, locateTools } from '@sheep/artifacts';
import { zip } from './bundle';
import type { PaperDocument } from './ir';
import { typesetPaper } from './paper';
import {
  assertProvenanced,
  ProvenanceError,
  unprovenanced,
  withoutUnprovenanced,
} from './provenance';
import { templateById } from './templates';
import { SAMPLE_CLAIM, sampleDocument } from './test-support';

vi.setConfig({ testTimeout: 120_000 });

/** The sample paper with one more sentence in its synthesis. */
function withSentence(text: string, claimIds: string[]): PaperDocument {
  const document = sampleDocument();
  return {
    ...document,
    sections: document.sections.map((section) =>
      section.id === 'synthesis'
        ? {
            ...section,
            blocks: [
              ...section.blocks,
              { kind: 'paragraph' as const, sentences: [{ text, asserts: true, claimIds }] },
            ],
          }
        : section,
    ),
  };
}

describe('the provenance rule', () => {
  it('passes a paper in which every asserting sentence names a ledger claim', () => {
    expect(unprovenanced(sampleDocument())).toEqual([]);
    expect(() => {
      assertProvenanced(sampleDocument());
    }).not.toThrow();
  });

  it('names a sentence that asserts something and cites nothing', () => {
    const document = withSentence('Sampling is therefore the best method known.', []);
    expect(unprovenanced(document)).toEqual([
      {
        section: 'Synthesis',
        text: 'Sampling is therefore the best method known.',
        reason: 'it names no claim in the ledger',
      },
    ]);
  });

  it('is not satisfied by an id the ledger does not hold', () => {
    const invented = '99999999-9999-4999-8999-999999999999';
    const [found] = unprovenanced(withSentence('A further result holds.', [invented]));
    expect(found?.reason).toBe(`claim ${invented} is not in the ledger`);

    // Nor by a finding stated under one.
    const document = sampleDocument();
    const stated = {
      ...document,
      labels: document.labels.filter((entry) => entry.claimId !== SAMPLE_CLAIM),
    };
    expect(unprovenanced(stated).map((entry) => entry.reason)).toContain(
      `claim ${SAMPLE_CLAIM} is not in the ledger`,
    );
  });

  it('breaks the build: there is no PDF of an unprovenanced sentence', async () => {
    const tools = locateTools(devToolsDir());
    const document = withSentence('Sampling is therefore the best method known.', []);
    const build = typesetPaper(document, templateById('sheep'), tools, () => new Uint8Array());

    await expect(build).rejects.toThrow(ProvenanceError);
    await expect(build).rejects.toThrow(/Sampling is therefore the best method known\./);
  });

  it('can leave the sentence out instead, and says exactly what it left out', () => {
    const { document, omitted } = withoutUnprovenanced(
      withSentence('Sampling is therefore the best method known.', []),
    );
    expect(omitted.map((entry) => entry.text)).toEqual([
      'Sampling is therefore the best method known.',
    ]);
    expect(unprovenanced(document)).toEqual([]);
    // Nothing else moved: what remains is the sample paper.
    expect(document.sections).toEqual(sampleDocument().sections);
  });
});

describe('the archive writer', () => {
  const files = [
    { path: 'README.txt', data: 'Sheep Research Record\n' },
    { path: 'figures/figure-1.pdf', data: Buffer.from('%PDF-1.5 not really'.repeat(50)) },
    { path: 'sources/ünïcode.dot', data: 'digraph { a -> b }' },
  ];

  it('writes an archive another tool can unpack to the same files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sheep-zip-'));
    try {
      writeFileSync(join(dir, 'bundle.zip'), zip(files));
      const tar = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
      execFileSync(tar, ['-xf', 'bundle.zip'], { cwd: dir });

      expect(readFileSync(join(dir, 'README.txt'), 'utf8')).toBe('Sheep Research Record\n');
      expect(
        readFileSync(join(dir, 'figures', 'figure-1.pdf')).equals(files[1]!.data as Buffer),
      ).toBe(true);
      expect(readFileSync(join(dir, 'sources', 'ünïcode.dot'), 'utf8')).toBe('digraph { a -> b }');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the same files to the same archive, whenever it is asked', async () => {
    const first = zip(files);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(Buffer.from(zip(files)).equals(Buffer.from(first))).toBe(true);
  });
});

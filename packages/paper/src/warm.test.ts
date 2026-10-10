import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devToolsDir } from '@sheep/artifacts';
import { emitLatex, TEMPLATES } from './templates';
import { sampleDocument } from './test-support';

/**
 * The fetch script fills the TeX cache by typesetting one document per
 * template, and the app then compiles offline against that cache. Those
 * documents are this package's own output for a sample paper, kept beside the
 * script. If a template's preamble changes and its warm-up document does not,
 * the next clean install would be missing a package — so this fails first.
 *
 *   SHEEP_UPDATE_WARM=1 npx vitest run packages/paper/src/warm.test.ts
 *
 * rewrites them; then `npm run fetch-tools` refills the cache.
 */
const warmDir = join(devToolsDir(), '..', 'scripts', 'warm');

describe('TeX cache warm-up documents', () => {
  it.each(TEMPLATES)('$id is what the emitter produces today', (template) => {
    const path = join(warmDir, `paper-${template.id}.tex`);
    const expected = emitLatex(sampleDocument(), template);
    if (process.env['SHEEP_UPDATE_WARM'] === '1') writeFileSync(path, expected);

    expect(existsSync(path), `${path} is missing; see the comment above`).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(expected);
  });
});

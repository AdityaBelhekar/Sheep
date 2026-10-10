import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { renderGraphviz } from './graphviz';
import { devToolsDir, expectedToolsHash, locateTools, RenderError } from './tools';

// Every test here starts a real `dot`, on a machine that may be busy.
vi.setConfig({ testTimeout: 120_000 });

const tools = locateTools(devToolsDir());

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

const GRAPH = `
digraph ledger {
  rankdir=LR;
  node [shape=box, fontname="Helvetica"];
  claim [label="EMPIRICAL claim"];
  run [label="execution\\n(seed 7)"];
  figure [label="figure.svg", shape=note];
  run -> claim [label="backs"];
  run -> figure [label="drew"];
}
`;

describe('graphviz rendering', () => {
  it('runs the pinned tools, and no others', () => {
    expect(tools.lockHash).toBe(expectedToolsHash());
    expect(tools.versions.graphviz).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('renders a graph to SVG and PDF', async () => {
    const { outputs, toolchain } = await renderGraphviz(tools, GRAPH);

    expect(toolchain).toBe(`graphviz ${tools.versions.graphviz}`);
    expect(outputs.map((output) => output.path)).toEqual(['diagram.svg', 'diagram.pdf']);
    const svg = Buffer.from(outputs[0]!.data).toString('utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('EMPIRICAL claim');
    expect(Buffer.from(outputs[1]!.data).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('renders the same graph to the same bytes, whenever it is asked', async () => {
    const first = await renderGraphviz(tools, GRAPH);
    // A PDF stamped with the clock would differ across a second boundary.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await renderGraphviz(tools, GRAPH);

    expect(second.outputs.map((output) => sha256(output.data))).toEqual(
      first.outputs.map((output) => sha256(output.data)),
    );
    // And the source is what decides them.
    const other = await renderGraphviz(tools, GRAPH.replace('seed 7', 'seed 8'));
    expect(sha256(other.outputs[0]!.data)).not.toBe(sha256(first.outputs[0]!.data));
  });

  it('reports a graph it cannot read in dot’s own words', async () => {
    const failure = renderGraphviz(tools, 'digraph { a -> }');
    await expect(failure).rejects.toThrow(RenderError);
    await expect(failure).rejects.toThrow(/syntax error in line 1/);
  });
});

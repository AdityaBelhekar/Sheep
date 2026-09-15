import { describe, expect, it } from 'vitest';
import type { Claim, Dispute } from '@sheep/core';
import { evidenceNodeId, layoutClaimGraph, lineageOf, NODE_WIDTH } from './claimGraph';

const AT = '2026-09-15T10:00:00.000Z';
const SESSION = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const X = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const D = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function claim(
  claimId: string,
  support: Claim['support'],
  status: Claim['status'] = 'asserted',
): Claim {
  return {
    claimId,
    sessionId: SESSION,
    phaseId: null,
    messageId: null,
    authorParticipantId: null,
    claimType: 'EMPIRICAL',
    statement: `claim ${claimId.slice(0, 1)}`,
    status,
    confidence: null,
    support,
    recordedAt: AT,
    updatedAt: AT,
  };
}

const run = { kind: 'EXECUTION' as const, ref: X };
const claims = [
  claim(A, [run]),
  claim(B, [run, { kind: 'CLAIM', ref: A }], 'disputed'),
  claim(C, [{ kind: 'CLAIM', ref: B }]),
];
const disputes: Dispute[] = [
  {
    disputeId: D,
    sessionId: SESSION,
    claimId: B,
    raisedByParticipantId: null,
    axis: 'BASELINES',
    severity: 'major',
    argument: 'No baseline.',
    proposedTest: null,
    status: 'open',
    openedAt: AT,
    resolvedAt: null,
  },
];

describe('claim graph layout', () => {
  const graph = layoutClaimGraph(claims, disputes);
  const node = (id: string) => graph.nodes.find((candidate) => candidate.id === id);

  it('layers evidence, then claims by support depth, then disputes', () => {
    const column = (id: string) => Math.round((node(id)?.x ?? -1) / (NODE_WIDTH + 64));
    expect(column(evidenceNodeId(run))).toBe(0);
    expect(column(A)).toBe(1);
    expect(column(B)).toBe(2);
    expect(column(C)).toBe(3);
    expect(column(D)).toBe(4);
    expect(node(B)?.status).toBe('disputed');
  });

  it('draws shared evidence once, with an edge to each claim resting on it', () => {
    expect(graph.nodes.filter((n) => n.kind === 'evidence')).toHaveLength(1);
    expect(graph.edges.filter((e) => e.from === evidenceNodeId(run))).toHaveLength(2);
    expect(graph.edges).toContainEqual({ from: D, to: B, kind: 'attacks' });
  });

  it('keeps every node inside the drawing', () => {
    for (const n of graph.nodes) {
      expect(n.x + NODE_WIDTH).toBeLessThanOrEqual(graph.width);
      expect(n.y).toBeLessThan(graph.height);
    }
  });

  it('traces a claim’s full lineage and nothing downstream of it', () => {
    expect(lineageOf(graph, C)).toEqual(new Set([C, B, A, evidenceNodeId(run), D]));
    expect(lineageOf(graph, A)).toEqual(new Set([A, evidenceNodeId(run)]));
  });

  it('starts at the first column when nothing has evidence yet', () => {
    const bare = layoutClaimGraph([claim(A, []), claim(B, [{ kind: 'CLAIM', ref: A }])], []);
    expect(bare.nodes.map((n) => n.x)).toEqual([16, 16 + NODE_WIDTH + 64]);
    expect(bare.width).toBe(16 * 2 + 2 * NODE_WIDTH + 64);
  });

  it('draws an empty ledger as an empty picture', () => {
    expect(layoutClaimGraph([], []).nodes).toEqual([]);
  });
});

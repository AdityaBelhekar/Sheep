import type { Claim, Dispute, EvidenceRef } from '@sheep/core';

/**
 * The claim ledger as a left-to-right DAG.
 *
 * Evidence sits in the first column, claims in columns by how deep their chain
 * of supporting claims runs, and disputes in the last column, pointing back at
 * what they attack. A layered layout rather than a force simulation: the
 * ledger is acyclic by rule, so its layers are its structure, and the same
 * ledger draws the same picture every time.
 */

export type GraphNodeKind = 'claim' | 'evidence' | 'dispute';

export interface GraphNode {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  /** Claim status, dispute status, or the evidence kind — what the colour keys off. */
  readonly status: string;
  readonly x: number;
  readonly y: number;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'supports' | 'attacks';
}

export interface ClaimGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly width: number;
  readonly height: number;
}

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 58;
const COLUMN_GAP = 64;
const ROW_GAP = 16;
const PADDING = 16;

/** Evidence of the same kind and ref is one node, however many claims rest on it. */
export function evidenceNodeId(evidence: EvidenceRef): string {
  return `${evidence.kind}:${evidence.ref}`;
}

export function layoutClaimGraph(
  claims: readonly Claim[],
  disputes: readonly Dispute[],
): ClaimGraph {
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
  const depths = new Map<string, number>();
  const depthOf = (claimId: string, seen: ReadonlySet<string> = new Set()): number => {
    const known = depths.get(claimId);
    if (known !== undefined) return known;
    const parents = (byId.get(claimId)?.support ?? []).filter(
      (evidence) => evidence.kind === 'CLAIM' && byId.has(evidence.ref) && !seen.has(evidence.ref),
    );
    const depth =
      parents.length === 0
        ? 0
        : 1 + Math.max(...parents.map((p) => depthOf(p.ref, new Set([...seen, claimId]))));
    depths.set(claimId, depth);
    return depth;
  };

  const columns: { id: string; kind: GraphNodeKind; label: string; status: string }[][] = [[]];
  const edges: GraphEdge[] = [];
  const seenEvidence = new Set<string>();
  const put = (column: number, node: (typeof columns)[number][number]): void => {
    while (columns.length <= column) columns.push([]);
    columns[column]?.push(node);
  };

  for (const claim of claims) {
    put(1 + depthOf(claim.claimId), {
      id: claim.claimId,
      kind: 'claim',
      label: claim.statement,
      status: claim.status,
    });
    for (const evidence of claim.support) {
      if (evidence.kind === 'CLAIM') {
        if (byId.has(evidence.ref)) {
          edges.push({ from: evidence.ref, to: claim.claimId, kind: 'supports' });
        }
        continue;
      }
      const id = evidenceNodeId(evidence);
      if (!seenEvidence.has(id)) {
        seenEvidence.add(id);
        put(0, {
          id,
          kind: 'evidence',
          label: evidence.note ?? evidence.ref,
          status: evidence.kind,
        });
      }
      edges.push({ from: id, to: claim.claimId, kind: 'supports' });
    }
  }

  const disputeColumn = columns.length;
  for (const dispute of disputes) {
    if (!byId.has(dispute.claimId)) continue;
    put(disputeColumn, {
      id: dispute.disputeId,
      kind: 'dispute',
      label: `${dispute.axis}: ${dispute.argument}`,
      status: dispute.status,
    });
    edges.push({ from: dispute.disputeId, to: dispute.claimId, kind: 'attacks' });
  }

  const nodes: GraphNode[] = columns.flatMap((column, c) =>
    column.map((node, r) => ({
      ...node,
      x: PADDING + c * (NODE_WIDTH + COLUMN_GAP),
      y: PADDING + r * (NODE_HEIGHT + ROW_GAP),
    })),
  );
  const rows = Math.max(1, ...columns.map((column) => column.length));
  return {
    nodes,
    edges,
    width: PADDING * 2 + columns.length * NODE_WIDTH + (columns.length - 1) * COLUMN_GAP,
    height: PADDING * 2 + rows * NODE_HEIGHT + (rows - 1) * ROW_GAP,
  };
}

/**
 * Everything a node's standing rests on: the claims beneath it, transitively,
 * with their evidence and the disputes raised against any of them.
 */
export function lineageOf(graph: ClaimGraph, nodeId: string): Set<string> {
  const into = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    into.set(edge.to, [...(into.get(edge.to) ?? []), edge]);
  }
  const lineage = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || lineage.has(id)) continue;
    lineage.add(id);
    for (const edge of into.get(id) ?? []) queue.push(edge.from);
  }
  return lineage;
}

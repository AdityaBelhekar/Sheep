import {
  critiqueAxisSchema,
  disputeSeveritySchema,
  domainEvent,
  proposedTestSchema,
  proseSchema,
  type DomainEvent,
} from '@sheep/core';
import { z } from 'zod';
import { RUN_TIMEOUT_MS } from './execution';
import { finalMethod } from './method';
import { critiquePrompt, ModelOutputError, parseJsonReply } from './prompts';
import {
  charterOf,
  claimsOfPhase,
  completedPhase,
  hypothesesOf,
  ledgerOf,
  turnsOf,
  type LabelledClaim,
  type RecordedTurn,
} from './reading';
import type { PhaseBody } from './tools';

/**
 * CRITIQUE: the findings are attacked, by other vendors' models, in a form the
 * ledger can hold.
 *
 * A critique is not a paragraph. It names the claim it is about, the axis it
 * attacks along, how serious it is, the argument — and, wherever one exists, a
 * test: something a program can run whose result would settle the point. Each
 * becomes a dispute in the ledger, attributed to the critic that raised it.
 *
 * The critics work blind and at once, and none of them shares a vendor with
 * the author of what they are reviewing. That is P1 doing its job: a model
 * marking its own vendor's homework has told nobody anything.
 */

/** Enough to cover a finding's real problems; not enough to bury it in noise. */
export const MAX_CRITIQUES_PER_CRITIC = 5;

/** Everything but the test, which is read separately so a malformed one costs only itself. */
const critiqueSchema = z.object({
  claim: z.string().min(1).max(40),
  axis: critiqueAxisSchema,
  severity: disputeSeveritySchema,
  argument: proseSchema,
});

const critiqueListSchema = z.object({ critiques: z.array(z.unknown()).max(50) });

/**
 * The disputes one critic's reply opens.
 *
 * Read entry by entry: one critique naming a claim that does not exist, or
 * carrying a test that is not well-formed, does not void the others. A test
 * that cannot be read is dropped and its critique kept — the argument still
 * stands, it simply has nothing to run.
 */
export function disputesFrom(
  turn: RecordedTurn,
  claims: readonly LabelledClaim[],
  sessionId: string,
  newId: () => string,
): DomainEvent[] {
  let entries: unknown[];
  try {
    entries = parseJsonReply(turn.text, critiqueListSchema, turn.participantId).critiques;
  } catch (error) {
    // A critic that answered in prose loses its say; the turn is still in the log.
    if (error instanceof ModelOutputError) return [];
    throw error;
  }

  const byLabel = new Map(claims.map((entry) => [entry.label, entry.claim.claimId]));
  const disputes: DomainEvent[] = [];
  for (const entry of entries) {
    if (disputes.length >= MAX_CRITIQUES_PER_CRITIC) break;
    const critique = critiqueSchema.safeParse(entry);
    if (!critique.success) continue;
    const claimId = byLabel.get(critique.data.claim.trim());
    if (claimId === undefined) continue;

    const test = proposedTestSchema.safeParse((entry as { proposedTest?: unknown }).proposedTest);
    disputes.push(
      domainEvent('dispute.opened', {
        sessionId,
        disputeId: newId(),
        claimId,
        axis: critique.data.axis,
        severity: critique.data.severity,
        argument: critique.data.argument,
        raisedByParticipantId: turn.participantId,
        ...(test.success ? { proposedTest: test.data } : {}),
      }),
    );
  }
  return disputes;
}

export const stepCritique: PhaseBody = async ({ tools, snapshot, state, phase }) => {
  const claims = claimsOfPhase(snapshot, completedPhase(state, 'EXECUTION'), 'C');
  if (claims.length === 0) {
    await tools.closePhase(
      snapshot.sessionId,
      state,
      phase,
      'complete',
      'no findings were recorded, so there was nothing to critique',
    );
    return;
  }

  const round = phase.rounds[0];
  if (!round) {
    const authors = [...new Set(claims.flatMap((entry) => entry.claim.authorParticipantId ?? []))];
    const authorVendors = new Set(
      snapshot.roster
        .filter((entry) => authors.includes(entry.participantId))
        .map((entry) => entry.model.vendorId),
    );
    const eligible = snapshot.roster.filter(
      (entry) => entry.weight > 0 && !authorVendors.has(entry.model.vendorId),
    );
    // With nobody from another vendor the solver refuses, and the phase fails:
    // findings nobody independent examined are not allowed to pass as examined.
    await tools.openRound(snapshot, state, phase, {
      index: 0,
      mode: 'BLIND_PARALLEL',
      demands: [{ role: 'CRITIC', count: Math.max(1, eligible.length) }],
      authors,
    });
    return;
  }

  if (round.status === 'open') {
    const method = finalMethod(snapshot, completedPhase(state, 'METHOD'));
    const run = await tools.ports.execute(snapshot.sessionId, {
      code: method.code,
      seed: method.seed,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    const prompt = critiquePrompt(
      charterOf(snapshot),
      hypothesesOf(snapshot, state),
      method,
      run,
      claims,
    );
    await tools.runBlindRound(snapshot, phase, round, () => prompt);

    // Read from a fresh snapshot: the turns were recorded after this one was taken.
    const after = await tools.ports.snapshot(snapshot.sessionId);
    const disputes = turnsOf(after.events, round.roundId).flatMap((turn) =>
      disputesFrom(turn, claims, snapshot.sessionId, tools.ports.newId),
    );
    await tools.closeRound(snapshot, state, phase, round, disputes);
    return;
  }

  const raised = ledgerOf(snapshot)
    .disputes()
    .filter((dispute) => claims.some((entry) => entry.claim.claimId === dispute.claimId));
  const blocking = raised.filter((dispute) => dispute.severity === 'blocking').length;
  await tools.closePhase(
    snapshot.sessionId,
    state,
    phase,
    'complete',
    `${String(round.spoke.length)} critic(s) from other vendors raised ${String(raised.length)} dispute(s) against ${String(claims.length)} finding(s), ${String(blocking)} of them blocking`,
  );
};

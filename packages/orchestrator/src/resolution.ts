import {
  domainEvent,
  type Claim,
  type Dispute,
  type DomainEvent,
  type Position,
  type RoleAssignment,
} from '@sheep/core';
import {
  ModelOutputError,
  parseJsonReply,
  positionsPrompt,
  positionsSchema,
  refereePrompt,
  refereeSchema,
  type PromptDispute,
} from './prompts';
import { charterOf, holderOf, ledgerOf, turnsOf } from './reading';
import type { RoundState } from './state';
import type { PhaseBody } from './tools';

/**
 * RESOLUTION: disputes end the way the evidence says, or they do not end.
 *
 * Every open dispute leaves this phase in one of three ways, and a model
 * chooses none of them:
 *
 * - A test that decided it has decided it. The dispute is resolved with that
 *   outcome and that evidence. The referee writes the rationale — what the
 *   test showed and why it bears on the claim — and cannot change the result;
 *   the ledger would refuse a resolution that tried.
 * - No test discriminates. The dispute is recorded as UNRESOLVED with both
 *   positions preserved, the author's and the critic's, each in its own words
 *   and with its own confidence. It ships as an open question (P6). Nobody is
 *   asked to settle by argument what could not be settled by evidence.
 * - The critic withdraws it, having seen the results.
 *
 * Positions are committed blind and at once, so neither side's final word is
 * shaped by the other's.
 */

/** Used for a position whose holder gave no number. Said to be unstated wherever it appears. */
const UNSTATED_CONFIDENCE = 0.5;

interface Party {
  readonly label: string;
  readonly dispute: Dispute;
  readonly claim: Claim;
  /** Null when a human wrote the claim or raised the dispute. */
  readonly author: string | null;
  readonly critic: string | null;
}

const has = (round: RoundState, role: RoleAssignment['role']): boolean =>
  [...round.assignments.values()].includes(role);

const decisive = (dispute: Dispute): boolean =>
  dispute.test !== null && dispute.test.outcome !== 'UNRESOLVED';

export const stepResolution: PhaseBody = async ({ tools, snapshot, state, phase }) => {
  const ledger = ledgerOf(snapshot);
  const attached = new Set(snapshot.roster.map((entry) => entry.participantId));
  const onRoster = (id: string | null): string | null =>
    id !== null && attached.has(id) ? id : null;

  const parties: Party[] = ledger
    .disputes()
    .filter((dispute) => dispute.status === 'open')
    .map((dispute, index) => {
      const claim = ledger.claim(dispute.claimId);
      return {
        label: `D${String(index + 1)}`,
        dispute,
        claim,
        author: onRoster(claim.authorParticipantId),
        critic: onRoster(dispute.raisedByParticipantId),
      };
    });

  if (parties.length === 0) {
    await tools.closePhase(
      snapshot.sessionId,
      state,
      phase,
      'complete',
      'no disputes were open, so there was nothing to resolve',
    );
    return;
  }

  const describe = (party: Party): PromptDispute => ({
    label: party.label,
    claim: party.claim.statement,
    axis: party.dispute.axis,
    severity: party.dispute.severity,
    argument: party.dispute.argument,
    test: party.dispute.test,
    proposed: party.dispute.proposedTest?.description ?? null,
  });

  const positionsRound = phase.rounds.find(
    (round) => has(round, 'PROPOSER') || has(round, 'CRITIC'),
  );
  const refereeRound = phase.rounds.find((round) => has(round, 'REFEREE'));
  const authors = [...new Set(parties.flatMap((party) => party.author ?? []))];
  const critics = [...new Set(parties.flatMap((party) => party.critic ?? []))].filter(
    (id) => !authors.includes(id),
  );

  // Round one: everyone party to a dispute commits a final position, blind.
  if (!positionsRound && !refereeRound && authors.length + critics.length > 0) {
    await tools.openRound(snapshot, state, phase, {
      index: phase.rounds.length,
      mode: 'BLIND_PARALLEL',
      fixed: [
        ...authors.map((participantId) => ({ participantId, role: 'PROPOSER' as const })),
        ...critics.map((participantId) => ({ participantId, role: 'CRITIC' as const })),
      ],
    });
    return;
  }

  if (positionsRound?.status === 'open') {
    const charter = charterOf(snapshot);
    await tools.runBlindRound(snapshot, phase, positionsRound, (participantId) => {
      const side = authors.includes(participantId) ? 'author' : 'critic';
      const theirs = parties.filter((party) =>
        side === 'author' ? party.author === participantId : party.critic === participantId,
      );
      return positionsPrompt(charter, side, theirs.map(describe));
    });
    await tools.closeRound(snapshot, state, phase, positionsRound);
    return;
  }

  /** What each party said about each dispute, keyed `participant|label`. */
  const stated = new Map<string, { confidence?: number; rationale?: string; withdraw?: boolean }>();
  if (positionsRound) {
    for (const turn of turnsOf(snapshot.events, positionsRound.roundId)) {
      try {
        for (const entry of parseJsonReply(turn.text, positionsSchema, turn.participantId)
          .positions) {
          stated.set(`${turn.participantId}|${entry.dispute.trim()}`, entry);
        }
      } catch (error) {
        // A party that answered in prose keeps the position it already took.
        if (!(error instanceof ModelOutputError)) throw error;
      }
    }
  }

  const positionOf = (party: Party, side: 'author' | 'critic'): Position | null => {
    const participantId = side === 'author' ? party.author : party.critic;
    if (participantId === null) return null;
    const said = stated.get(`${participantId}|${party.label}`);
    const fallback = side === 'author' ? party.claim.statement : party.dispute.argument;
    const confidence = said?.confidence ?? (side === 'author' ? party.claim.confidence : null);
    return {
      participantId,
      stance: side === 'author' ? 'SUPPORT' : 'OPPOSE',
      confidence: confidence ?? UNSTATED_CONFIDENCE,
      rationale:
        (said?.rationale ?? fallback).slice(0, 19_000) +
        (confidence === null || confidence === undefined ? ' (confidence not stated)' : ''),
    };
  };

  // Round two: one referee writes the rationale for each dispute.
  if (!refereeRound) {
    // Unstaked if the roster allows it: nobody party to any dispute. Failing
    // that, at least not an author — the referee decides nothing either way.
    const everyone = [...authors, ...critics];
    let lastError: unknown;
    for (const staked of [everyone, authors, []]) {
      try {
        await tools.openRound(snapshot, state, phase, {
          index: phase.rounds.length,
          mode: 'SEQUENTIAL',
          demands: [{ role: 'REFEREE', count: 1 }],
          authors: staked,
        });
        return;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('cannot be staffed')) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  if (refereeRound.status === 'open') {
    const prompt = refereePrompt(
      charterOf(snapshot),
      parties.map((party) => ({
        ...describe(party),
        author: positionOf(party, 'author'),
        critic: positionOf(party, 'critic'),
      })),
    );
    await tools.runTurn(
      snapshot,
      phase,
      refereeRound,
      holderOf(refereeRound, 'REFEREE'),
      'REFEREE',
      prompt,
    );
    await tools.closeRound(snapshot, state, phase, refereeRound);
    return;
  }

  const referee = holderOf(refereeRound, 'REFEREE');
  const rationales = new Map<string, string>();
  const ruling = turnsOf(snapshot.events, refereeRound.roundId).at(-1);
  if (ruling) {
    try {
      for (const entry of parseJsonReply(ruling.text, refereeSchema, ruling.participantId)
        .rationales) {
        rationales.set(entry.dispute.trim(), entry.rationale);
      }
    } catch (error) {
      // Without a readable rationale the evidence still decides what it decided.
      if (!(error instanceof ModelOutputError)) throw error;
    }
  }

  const events: DomainEvent[] = [];
  const tally = { UPHELD: 0, OVERTURNED: 0, UNRESOLVED: 0, withdrawn: 0, left: 0 };

  for (const party of parties) {
    const { dispute, label } = party;
    const base = { sessionId: snapshot.sessionId, disputeId: dispute.disputeId };
    const positions = [positionOf(party, 'author'), positionOf(party, 'critic')].flatMap(
      (position) => position ?? [],
    );

    if (decisive(dispute) && dispute.test?.evidence) {
      // The outcome is read off the test. Whatever the referee wrote, this
      // line does not consult it.
      events.push(
        domainEvent('dispute.resolved', {
          ...base,
          outcome: dispute.test.outcome,
          rationale: rationales.get(label) ?? `Decided by the test: ${dispute.test.detail}`,
          evidence: [dispute.test.evidence],
          resolvedByParticipantId: referee,
          ...(positions.length > 0 ? { positions } : {}),
        }),
      );
      tally[dispute.test.outcome] += 1;
      continue;
    }

    const withdrawn =
      party.critic !== null && stated.get(`${party.critic}|${label}`)?.withdraw === true;
    if (withdrawn) {
      const reason = stated.get(`${party.critic ?? ''}|${label}`)?.rationale;
      events.push(
        domainEvent('dispute.withdrawn', {
          ...base,
          ...(reason ? { reason: reason.slice(0, 20_000) } : {}),
        }),
      );
      tally.withdrawn += 1;
      continue;
    }

    // An open question needs both sides on record. A dispute with a side
    // missing — a claim a human wrote, a critic since detached — stays open
    // rather than being recorded as something it is not.
    if (positions.length < 2) {
      tally.left += 1;
      continue;
    }
    const why = dispute.test
      ? `the test that was run could not decide it (${dispute.test.detail})`
      : 'no test that could be run here was proposed';
    events.push(
      domainEvent('dispute.resolved', {
        ...base,
        outcome: 'UNRESOLVED',
        rationale: rationales.get(label) ?? `Left open: ${why}.`,
        evidence: dispute.test?.evidence ? [dispute.test.evidence] : [],
        resolvedByParticipantId: referee,
        positions,
      }),
    );
    tally.UNRESOLVED += 1;
  }

  await tools.closePhase(
    snapshot.sessionId,
    state,
    phase,
    'complete',
    `of ${String(parties.length)} dispute(s): ${String(tally.UPHELD)} claim(s) upheld and ${String(
      tally.OVERTURNED,
    )} overturned by a test, ${String(tally.UNRESOLVED)} left unresolved with both positions kept, ${String(
      tally.withdrawn,
    )} withdrawn${tally.left > 0 ? `, ${String(tally.left)} left open` : ''}`,
    events,
  );
};

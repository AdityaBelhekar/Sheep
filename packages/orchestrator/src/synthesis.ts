import { canEstablishAlone, domainEvent, type Claim, type Dispute, type Ledger } from '@sheep/core';
import { RUN_TIMEOUT_MS, unearnedNumbers } from './execution';
import { finalMethod } from './method';
import { synthesisPrompt } from './prompts';
import {
  charterOf,
  claimsOfPhase,
  completedPhase,
  holderOf,
  hypothesesOf,
  ledgerOf,
  turnsOf,
  type LabelledClaim,
} from './reading';
import type { PhaseBody } from './tools';

/**
 * SYNTHESIS: what the session found, written from the ledger and from nothing
 * else.
 *
 * By now every finding has a status that evidence gave it. Two things happen
 * here. Findings that were backed by a run and came through critique with
 * nothing outstanding against them are marked supported — the one status the
 * protocol itself confers, and only on a claim type that can stand alone. Then
 * one participant writes the account: what was asked, what stands, what was
 * refuted, and what remains open, with both sides of each open question.
 *
 * The scribe is handed the ledger's contents, not asked to recall them. Any
 * figure in its account that appears nowhere in the record is named in the
 * phase summary: a synthesis is the last place an unearned result could slip
 * in, so it is checked the same way a finding is.
 */

/** A finding with nothing left against it: asserted, backed, and able to stand alone. */
function standing(claim: Claim): boolean {
  return claim.status === 'asserted' && canEstablishAlone(claim.claimType);
}

/** The ledger as the scribe is given it. Plain text, built here, so it is the same for every model. */
export function digestOf(
  ledger: Ledger,
  hypotheses: readonly LabelledClaim[],
  findings: readonly LabelledClaim[],
): string {
  const labelOf = new Map(findings.map((entry) => [entry.claim.claimId, entry.label]));
  const line = (entry: LabelledClaim): string => {
    const claim = ledger.claim(entry.claim.claimId);
    return `[${entry.label}] (${claim.claimType}, ${claim.status}) ${claim.statement}`;
  };
  const disputeLine = (dispute: Dispute): string[] => {
    const resolution = ledger.resolutions().find((entry) => entry.disputeId === dispute.disputeId);
    const about = labelOf.get(dispute.claimId) ?? 'a claim';
    const head = `- Against ${about} (${dispute.axis}, ${dispute.severity}): ${dispute.argument}`;
    if (dispute.status === 'withdrawn') return [head, '  Withdrawn by the critic.'];
    if (!resolution) return [head, '  Still open.'];
    if (resolution.outcome !== 'UNRESOLVED') {
      return [
        head,
        `  ${resolution.outcome === 'UPHELD' ? 'The finding survived' : 'The finding was refuted'}: ${dispute.test?.detail ?? resolution.rationale}`,
      ];
    }
    return [
      head,
      '  UNRESOLVED — an open question. Both positions:',
      ...resolution.positions.map(
        (position) =>
          `    ${position.stance} (confidence ${position.confidence.toFixed(2)}): ${position.rationale ?? ''}`,
      ),
    ];
  };

  return [
    'HYPOTHESES',
    ...hypotheses.map(line),
    '',
    'FINDINGS',
    ...(findings.length === 0 ? ['(none were recorded)'] : findings.map(line)),
    '',
    'DISPUTES',
    ...(ledger.disputes().length === 0
      ? ['(none were raised)']
      : ledger.disputes().flatMap(disputeLine)),
  ].join('\n');
}

export const stepSynthesis: PhaseBody = async ({ tools, snapshot, state, phase }) => {
  const ledger = ledgerOf(snapshot);
  const findings = claimsOfPhase(snapshot, completedPhase(state, 'EXECUTION'), 'C');

  // Before anything is written: a finding that survived is recorded as such.
  const survivors = findings.filter((entry) => standing(ledger.claim(entry.claim.claimId)));
  if (survivors.length > 0) {
    await tools.ports.record(
      snapshot.sessionId,
      survivors.map((entry) =>
        domainEvent('claim.status-changed', {
          sessionId: snapshot.sessionId,
          claimId: entry.claim.claimId,
          status: 'supported',
          reason:
            'backed by a recorded run, and nothing raised against it in critique is outstanding',
        }),
      ),
    );
    return;
  }

  const round = phase.rounds[0];
  if (!round) {
    await tools.openRound(snapshot, state, phase, {
      index: 0,
      mode: 'SEQUENTIAL',
      demands: [{ role: 'SCRIBE', count: 1 }],
    });
    return;
  }

  const hypotheses = hypothesesOf(snapshot, state);
  const digest = digestOf(ledger, hypotheses, findings);

  if (round.status === 'open') {
    await tools.runTurn(
      snapshot,
      phase,
      round,
      holderOf(round, 'SCRIBE'),
      'SCRIBE',
      synthesisPrompt(snapshot.question, charterOf(snapshot), digest),
    );
    await tools.closeRound(snapshot, state, phase, round);
    return;
  }

  const text = turnsOf(snapshot.events, round.roundId).at(-1)?.text ?? '';
  const method = finalMethod(snapshot, completedPhase(state, 'METHOD'));
  const run = await tools.ports.execute(snapshot.sessionId, {
    code: method.code,
    seed: method.seed,
    timeoutMs: RUN_TIMEOUT_MS,
  });
  const invented = [
    ...new Set(
      unearnedNumbers(text, [digest, run.stdout, method.plan, method.analysis].join('\n')),
    ),
  ];

  const count = (status: Claim['status']): number =>
    findings.filter((entry) => ledger.claim(entry.claim.claimId).status === status).length;
  await tools.closePhase(
    snapshot.sessionId,
    state,
    phase,
    'complete',
    `${String(findings.length)} finding(s): ${String(count('supported'))} supported, ${String(
      count('refuted'),
    )} refuted, ${String(count('unresolved'))} with an open question` +
      (invented.length === 0
        ? ''
        : `. The written synthesis quotes ${invented.join(', ')}, which appear nowhere in the record`),
  );
};

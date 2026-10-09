import { describe, expect, it } from 'vitest';
import { PHASE_KINDS, type DomainEvent } from '@sheep/core';
import { Orchestrator, type RunOutcome } from './engine';
import type { TurnRequest } from './ports';
import { ledgerOf } from './reading';
import { violations } from './roles';
import {
  fakePorts,
  runPastGates,
  scriptedReply,
  scriptedRun,
  type FakePorts,
} from './test-support';

const SESSION = '11111111-1111-4111-8111-111111111111';
const ROSTER = [
  { participantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', vendorId: 'anthropic' },
  { participantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', vendorId: 'openai' },
  { participantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', vendorId: 'google' },
];

/**
 * Every critic raises both kinds of dispute against the measured finding: one
 * with a test the sandbox can run, one with a test nothing here can. Whoever
 * rotation makes the author, the session then has both in it.
 */
const BOTH_KINDS = JSON.stringify({
  critiques: [
    {
      claim: 'C1',
      axis: 'BASELINES',
      severity: 'major',
      argument: 'The delta is not compared against a dense baseline.',
      proposedTest: {
        route: 'SANDBOX',
        description: 'Recompute the delta against the dense baseline.',
        code: 'print("SHEEP_TEST: PASS")',
      },
    },
    {
      claim: 'C1',
      axis: 'SCOPE',
      severity: 'minor',
      argument: 'A synthetic corpus says little about natural text.',
      proposedTest: { route: 'MANUAL', description: 'Repeat on a natural-language corpus.' },
    },
  ],
});

const sessionReply = (request: TurnRequest): string =>
  request.prompt.includes('Critique the findings') ? BOTH_KINDS : scriptedReply(request);

const newPorts = (): FakePorts =>
  fakePorts({ sessionId: SESSION, roster: ROSTER, reply: sessionReply, run: scriptedRun });

const engineOn = (ports: FakePorts): Orchestrator =>
  new Orchestrator(ports, { seed: 'test', concurrency: 3 });

/**
 * What a session concluded, with everything that legitimately differs between
 * two runs of it — ids — left out. Two sessions that reached the same
 * conclusions by the same evidence have the same summary.
 */
async function conclusions(ports: FakePorts) {
  const ledger = ledgerOf(await ports.snapshot(SESSION));
  const statement = new Map(ledger.claims().map((claim) => [claim.claimId, claim.statement]));
  return {
    claims: ledger
      .claims()
      .map((claim) => [claim.claimType, claim.status, claim.statement])
      .sort(),
    disputes: ledger
      .disputes()
      .map((dispute) => [
        statement.get(dispute.claimId),
        dispute.argument,
        dispute.status,
        dispute.test?.verdict ?? null,
        ledger.resolutions().find((entry) => entry.disputeId === dispute.disputeId)?.outcome ??
          null,
      ])
      .sort(),
    rejected: ledger.rejected.length,
  };
}

const count = (events: readonly DomainEvent[], type: DomainEvent['type']): number =>
  events.filter((event) => event.type === type).length;

describe('a whole session', () => {
  it('runs all seven phases, stopping for a person exactly twice', async () => {
    const ports = newPorts();
    const outcome = (await runPastGates(engineOn(ports), SESSION)) as RunOutcome;

    expect(outcome.status).toBe('complete');
    expect(outcome.state.status).toBe('complete');
    expect(outcome.state.phases.map((phase) => [phase.kind, phase.status])).toEqual(
      PHASE_KINDS.map((kind) => [kind, 'complete']),
    );
    expect(outcome.state.nextPhase).toBeNull();
    // The charter and the choice of hypotheses. Nothing else waited for anyone.
    expect(count(ports.events, 'phase.gate-raised')).toBe(2);
    expect(count(ports.events, 'phase.gate-resolved')).toBe(2);
  });

  it('ends with every finding in a state evidence gave it', async () => {
    const ports = newPorts();
    await runPastGates(engineOn(ports), SESSION);
    const summary = await conclusions(ports);

    // One measured finding, tested and upheld, with one question left open on
    // it; one interpretation, which stays a conjecture.
    expect(summary.claims).toContainEqual([
      'EMPIRICAL',
      'unresolved',
      'The perplexity delta is 0.31, above the 0.02 threshold.',
    ]);
    expect(
      summary.disputes.map(([, , status, verdict, outcome]) => [status, verdict, outcome]),
    ).toEqual(
      expect.arrayContaining([
        ['resolved', 'PASS', 'UPHELD'],
        ['unresolved', null, 'UNRESOLVED'],
      ]),
    );
    // No dispute is left hanging, and the ledger refused nothing the engine wrote.
    expect(summary.disputes.every(([, , status]) => status !== 'open')).toBe(true);
    expect(summary.rejected).toBe(0);
  });

  it('marks a finding supported only when nothing is outstanding against it', async () => {
    const ports = fakePorts({
      sessionId: SESSION,
      roster: ROSTER,
      run: scriptedRun,
      reply: (request) =>
        request.prompt.includes('Critique the findings')
          ? '{"critiques":[]}'
          : sessionReply(request),
    });
    const outcome = (await runPastGates(engineOn(ports), SESSION)) as RunOutcome;
    const summary = await conclusions(ports);

    expect(summary.claims).toContainEqual([
      'EMPIRICAL',
      'supported',
      'The perplexity delta is 0.31, above the 0.02 threshold.',
    ]);
    // A conjecture can never be promoted, critiqued or not.
    expect(
      summary.claims.filter(([type]) => type === 'CONJECTURE').map(([, status]) => status),
    ).toEqual(expect.arrayContaining(['asserted']));
    expect(outcome.state.phases.at(-1)?.summary).toContain('1 supported');
  });

  it('hands the scribe the ledger, and names any figure it adds to it', async () => {
    const honest = newPorts();
    const first = (await runPastGates(engineOn(honest), SESSION)) as RunOutcome;
    const [scribe] = honest.asked.filter((request) => request.role === 'SCRIBE');
    expect(scribe!.prompt).toContain('[C1] (EMPIRICAL, unresolved) The perplexity delta is 0.31');
    expect(scribe!.prompt).toContain('UNRESOLVED — an open question. Both positions:');
    expect(scribe!.prompt).toContain('The finding survived');
    expect(first.state.phases.at(-1)?.summary).not.toContain('appear nowhere in the record');

    const embellishing = fakePorts({
      sessionId: SESSION,
      roster: ROSTER,
      run: scriptedRun,
      reply: (request) =>
        request.prompt.includes('Write the synthesis of this session')
          ? 'ANSWER — the delta is 0.31, a 47.5% degradation that generalises.'
          : sessionReply(request),
    });
    const second = (await runPastGates(engineOn(embellishing), SESSION)) as RunOutcome;
    expect(second.state.phases.at(-1)?.summary).toContain(
      'quotes 47.5%, which appear nowhere in the record',
    );
  });

  it('staffs every round legally, across all seven phases (P1)', async () => {
    const ports = newPorts();
    const outcome = (await runPastGates(engineOn(ports), SESSION)) as RunOutcome;
    const participants = ROSTER.map((entry) => ({ ...entry }));

    for (const phase of outcome.state.phases) {
      for (const round of phase.rounds) {
        expect(violations(round.assignments, { participants, demands: [] })).toEqual([]);
      }
    }
  });

  it('reaches the same conclusions when killed and reopened at any point', async () => {
    const uninterrupted = newPorts();
    await runPastGates(engineOn(uninterrupted), SESSION);
    const expected = await conclusions(uninterrupted);

    // Every place a crash could leave the log after the second gate: the end
    // of each atomic write. From each, a fresh engine with no memory of the
    // run must finish the session and conclude exactly the same things.
    const afterGates = uninterrupted.events.findLastIndex(
      (event) => event.type === 'phase.gate-resolved',
    );
    const cuts = uninterrupted.commitPoints.filter((length) => length > afterGates);
    expect(cuts.length).toBeGreaterThan(30);

    for (const cut of cuts) {
      const reopened = uninterrupted.fork(uninterrupted.events.slice(0, cut));
      const outcome = await engineOn(reopened).run(SESSION);
      expect(outcome.status, `resumed from ${String(cut)}: ${outcome.detail}`).toBe('complete');
      expect(await conclusions(reopened), `resumed from ${String(cut)}`).toEqual(expected);
      expect(count(reopened.events, 'phase.opened'), `resumed from ${String(cut)}`).toBe(7);
    }
  });

  it('replays a recorded session identically, calling no model', async () => {
    const fixture = new Map<string, string>();
    const key = (request: { participantId: string; role: string; prompt: string }): string =>
      [request.participantId, request.role, request.prompt].join('|');
    const recorded = fakePorts({
      sessionId: SESSION,
      roster: ROSTER,
      run: scriptedRun,
      reply: (request) => {
        const answer = sessionReply(request);
        fixture.set(key(request), answer);
        return answer;
      },
    });
    await runPastGates(engineOn(recorded), SESSION);

    let misses = 0;
    const replayed = fakePorts({
      sessionId: SESSION,
      roster: ROSTER,
      run: scriptedRun,
      reply: (request) => fixture.get(key(request)) ?? ((misses += 1), 'FIXTURE MISS'),
    });
    await runPastGates(engineOn(replayed), SESSION);

    // Seven phases, and the two logs are the same events with the same ids.
    expect(misses).toBe(0);
    expect(replayed.events).toEqual(recorded.events);
  });
});

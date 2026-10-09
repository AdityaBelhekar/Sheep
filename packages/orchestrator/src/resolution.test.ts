import { describe, expect, it } from 'vitest';
import type { ProposedTest } from '@sheep/core';
import { Orchestrator, type RunOutcome } from './engine';
import type { RunCodeRequest, TurnRequest } from './ports';
import { ledgerOf } from './reading';
import {
  fakePorts,
  positionsReply,
  refereeReply,
  runPastGates,
  scriptedReply,
  scriptedRun,
  type FakePorts,
} from './test-support';

const SESSION = '11111111-1111-4111-8111-111111111111';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CARA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DANA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const TWO = [
  { participantId: ALICE, vendorId: 'anthropic' },
  { participantId: BOB, vendorId: 'openai' },
];

type Critique = {
  argument: string;
  proposedTest?: Partial<ProposedTest> & { description: string };
};

const runnable = (line: 'PASS' | 'FAIL', tag = ''): Critique['proposedTest'] => ({
  route: 'SANDBOX',
  description: 'A script that checks the finding.',
  code: `print("SHEEP_TEST: ${line}")  # ${tag}`,
});
const manual: Critique['proposedTest'] = {
  route: 'MANUAL',
  description: 'Repeat on a natural-language corpus.',
};

/** A session in which every critic raises exactly these critiques of finding C1. */
function sessionWith(
  critiques: Critique[],
  overrides: Partial<Parameters<typeof fakePorts>[0]> = {},
): FakePorts {
  const reply = overrides.reply ?? scriptedReply;
  return fakePorts({
    sessionId: SESSION,
    roster: TWO,
    ...overrides,
    run: (request: RunCodeRequest) =>
      request.code.includes('SHEEP_TEST')
        ? { stdout: request.code.includes('FAIL') ? 'SHEEP_TEST: FAIL' : 'SHEEP_TEST: PASS' }
        : scriptedRun(),
    reply: (request: TurnRequest, index: number) =>
      request.prompt.includes('Critique the findings')
        ? JSON.stringify({
            critiques: critiques.map((critique) => ({
              claim: 'C1',
              axis: 'BASELINES',
              severity: 'major',
              ...critique,
            })),
          })
        : reply(request, index),
  });
}

async function resolved(ports: FakePorts) {
  const engine = new Orchestrator(ports, { seed: 'test', concurrency: 3 });
  const outcome = (await runPastGates(engine, SESSION)) as RunOutcome;
  const resolution = outcome.state.phases.find((phase) => phase.kind === 'RESOLUTION');
  if (!resolution) throw new Error(`RESOLUTION never opened: ${outcome.detail}`);
  const ledger = ledgerOf(await ports.snapshot(SESSION));
  const finding = ledger.claims().find((claim) => claim.claimType === 'EMPIRICAL')!;
  const byArgument = (argument: string) => {
    const dispute = ledger.disputes().find((candidate) => candidate.argument === argument)!;
    return {
      dispute,
      resolution: ledger.resolutions().find((entry) => entry.disputeId === dispute.disputeId),
    };
  };
  return { outcome, resolution, ledger, finding, byArgument };
}

const asked = (ports: FakePorts, text: string): TurnRequest[] =>
  ports.asked.filter((request) => request.prompt.includes(text));

describe('RESOLUTION', () => {
  it('resolves a tested dispute the way the test came out, citing it', async () => {
    const ports = sessionWith([
      { argument: 'It should survive this.', proposedTest: runnable('PASS') },
      { argument: 'It should not survive this.', proposedTest: runnable('FAIL') },
    ]);
    const { byArgument, finding, ledger, resolution } = await resolved(ports);

    const survived = byArgument('It should survive this.');
    expect(survived.dispute.status).toBe('resolved');
    expect(survived.resolution).toMatchObject({
      outcome: 'UPHELD',
      evidence: [survived.dispute.test!.evidence],
      rationale: expect.stringContaining('Referee on D1') as string,
    });

    const refuted = byArgument('It should not survive this.');
    expect(refuted.resolution).toMatchObject({
      outcome: 'OVERTURNED',
      evidence: [refuted.dispute.test!.evidence],
    });
    // One failed test is enough: the finding is refuted, by evidence.
    expect(finding.status).toBe('refuted');
    expect(resolution.status).toBe('complete');
    expect(resolution.summary).toContain('1 claim(s) upheld and 1 overturned by a test');
    expect(ledger.rejected).toEqual([]);
  });

  it('leaves a dispute no test could decide unresolved, with both positions kept', async () => {
    const ports = sessionWith([
      { argument: 'Only a real corpus would tell.', proposedTest: manual },
    ]);
    const { byArgument, finding } = await resolved(ports);

    const { dispute, resolution } = byArgument('Only a real corpus would tell.');
    expect(dispute.status).toBe('unresolved');
    expect(resolution!.outcome).toBe('UNRESOLVED');

    const author = finding.authorParticipantId;
    const critic = dispute.raisedByParticipantId;
    // Each side in its own words, with its own confidence — not a summary of either.
    expect(resolution!.positions).toEqual([
      {
        participantId: author,
        stance: 'SUPPORT',
        confidence: 0.8,
        rationale: 'Author on D1: the measured delta stands on the printed output.',
      },
      {
        participantId: critic,
        stance: 'OPPOSE',
        confidence: 0.6,
        rationale: 'Critic on D1: the comparison this rests on was never made.',
      },
    ]);
    expect(finding.status).toBe('unresolved');
  });

  it('does not let the referee overrule the evidence', async () => {
    const ports = sessionWith(
      [{ argument: 'It should not survive this.', proposedTest: runnable('FAIL') }],
      {
        reply: (request) =>
          request.prompt.includes('Write the rationale for each')
            ? JSON.stringify({
                rationales: [
                  {
                    dispute: 'D1',
                    outcome: 'UPHELD',
                    rationale: 'The test is flawed; I rule the finding stands.',
                  },
                ],
              })
            : scriptedReply(request),
      },
    );
    const { byArgument, finding, ledger } = await resolved(ports);

    // Its words are on the record. The outcome is the test's.
    const { resolution } = byArgument('It should not survive this.');
    expect(resolution!.rationale).toBe('The test is flawed; I rule the finding stands.');
    expect(resolution!.outcome).toBe('OVERTURNED');
    expect(finding.status).toBe('refuted');
    expect(ledger.rejected).toEqual([]);
  });

  it('has each side commit its final position blind, on its own disputes only', async () => {
    const ports = sessionWith([
      { argument: 'Only a real corpus would tell.', proposedTest: manual },
    ]);
    await resolved(ports);

    const positions = asked(ports, 'State your final position on each');
    expect(positions.map((request) => request.role).sort()).toEqual(['CRITIC', 'PROPOSER']);
    for (const request of positions) {
      expect(request.prompt).toContain('[D1]');
      // Neither is shown what the other is about to say.
      expect(request.prompt).not.toContain('Author on D1');
      expect(request.prompt).not.toContain('Critic on D1');
    }
    expect(positions.find((r) => r.role === 'PROPOSER')!.prompt).toContain(
      'raised against findings you recorded',
    );
    // The referee, afterwards, sees both.
    const [referee] = asked(ports, 'Write the rationale for each');
    expect(referee!.prompt).toContain('Author on D1');
    expect(referee!.prompt).toContain('Critic on D1');
  });

  it('tells the referee what the checker found, and that the outcome is not its to choose', async () => {
    const ports = sessionWith([
      { argument: 'It should not survive this.', proposedTest: runnable('FAIL') },
      { argument: 'Only a real corpus would tell.', proposedTest: manual },
    ]);
    await resolved(ports);

    const [referee] = asked(ports, 'Write the rationale for each');
    expect(referee!.role).toBe('REFEREE');
    expect(referee!.prompt).toContain('Verdict FAIL: it refuted the finding');
    expect(referee!.prompt).toContain('could not be run here: Repeat on a natural-language corpus');
    expect(referee!.prompt).toContain('The outcomes are already fixed, and not by you');
  });

  it('picks a referee with no stake in any dispute when the roster has one', async () => {
    // Four vendors. One critic finds nothing wrong, so is party to no dispute.
    let author = '';
    const quiet = (): string => (author === DANA ? CARA : DANA);
    const ports = fakePorts({
      sessionId: SESSION,
      roster: [
        ...TWO,
        { participantId: CARA, vendorId: 'google' },
        { participantId: DANA, vendorId: 'mistral' },
      ],
      run: scriptedRun,
      reply: (request) => {
        if (request.prompt.includes('Design the method that will test them')) {
          author = request.participantId;
        }
        return request.prompt.includes('Critique the findings') && request.participantId === quiet()
          ? '{"critiques":[]}'
          : scriptedReply(request);
      },
    });
    const { resolution, ledger, finding } = await resolved(ports);

    const referee = resolution.rounds.at(-1)!.assignments[0]!;
    expect(referee.role).toBe('REFEREE');
    expect(finding.authorParticipantId).toBe(author);
    expect(ledger.disputes().map((dispute) => dispute.raisedByParticipantId)).not.toContain(
      quiet(),
    );
    // The only model with nothing riding on the outcome.
    expect(referee.participantId).toBe(quiet());
  });

  it('falls back to a referee who is at least not the author', async () => {
    const ports = sessionWith([
      { argument: 'Only a real corpus would tell.', proposedTest: manual },
    ]);
    const { resolution, finding } = await resolved(ports);

    // Two models: one wrote the finding, the other critiqued it.
    const referee = resolution.rounds.at(-1)!.assignments[0]!;
    expect(referee.role).toBe('REFEREE');
    expect(referee.participantId).not.toBe(finding.authorParticipantId);
  });

  it('lets a critic withdraw an undecided dispute, but not undo a decided one', async () => {
    const ports = sessionWith(
      [
        { argument: 'Only a real corpus would tell.', proposedTest: manual },
        { argument: 'It should not survive this.', proposedTest: runnable('FAIL') },
      ],
      {
        reply: (request) =>
          request.prompt.includes('State your final position on each') && request.role === 'CRITIC'
            ? JSON.stringify({
                positions: ['D1', 'D2'].map((dispute) => ({
                  dispute,
                  confidence: 0.1,
                  rationale: 'On reflection the output answers this.',
                  withdraw: true,
                })),
              })
            : scriptedReply(request),
      },
    );
    const { byArgument, resolution } = await resolved(ports);

    expect(byArgument('Only a real corpus would tell.').dispute.status).toBe('withdrawn');
    // The test already refuted the finding. A change of heart does not unrun it.
    expect(byArgument('It should not survive this.').resolution?.outcome).toBe('OVERTURNED');
    expect(resolution.summary).toContain('1 withdrawn');
  });

  it('still resolves everything when nobody answers usefully', async () => {
    const ports = sessionWith(
      [
        { argument: 'It should survive this.', proposedTest: runnable('PASS') },
        { argument: 'Only a real corpus would tell.', proposedTest: manual },
      ],
      {
        reply: (request) =>
          request.prompt.includes('State your final position on each') ||
          request.prompt.includes('Write the rationale for each')
            ? 'I have nothing to add.'
            : scriptedReply(request),
      },
    );
    const { byArgument, ledger } = await resolved(ports);

    const tested = byArgument('It should survive this.').resolution!;
    expect(tested.outcome).toBe('UPHELD');
    expect(tested.rationale).toBe('Decided by the test: the test script reported PASS');

    // Both sides still on record: what each had already said, marked as such.
    const open = byArgument('Only a real corpus would tell.').resolution!;
    expect(open.outcome).toBe('UNRESOLVED');
    expect(open.rationale).toBe('Left open: no test that could be run here was proposed.');
    expect(open.positions.map((position) => position.stance)).toEqual(['SUPPORT', 'OPPOSE']);
    expect(open.positions[1]!.rationale).toBe(
      'Only a real corpus would tell. (confidence not stated)',
    );
    expect(ledger.rejected).toEqual([]);
  });

  it('closes at once when there is nothing in dispute', async () => {
    const ports = sessionWith([]);
    const { resolution } = await resolved(ports);

    expect(resolution.status).toBe('complete');
    expect(resolution.rounds).toEqual([]);
    expect(asked(ports, 'Write the rationale for each')).toEqual([]);
  });

  it('resolves each dispute once, however the session is resumed', async () => {
    const full = sessionWith([
      { argument: 'It should not survive this.', proposedTest: runnable('FAIL') },
      { argument: 'Only a real corpus would tell.', proposedTest: manual },
    ]);
    await resolved(full);

    // Cut after the positions were committed, before the referee spoke.
    const lastPosition = full.events.findLastIndex(
      (event) =>
        event.type === 'message.recorded' &&
        event.payload.body.kind === 'text' &&
        event.payload.body.text.includes('"positions"'),
    );
    const reopened = full.fork(full.events.slice(0, lastPosition + 1));
    await new Orchestrator(reopened, { seed: 'test' }).run(SESSION);

    expect(reopened.events.filter((event) => event.type === 'dispute.resolved')).toHaveLength(2);
    expect(asked(reopened, 'State your final position on each')).toEqual([]);
    expect(ledgerOf(await reopened.snapshot(SESSION)).rejected).toEqual([]);
    expect(positionsReply({ role: 'PROPOSER', prompt: '[D1] x' } as TurnRequest)).toContain('D1');
    expect(refereeReply('[D1] x')).toContain('D1');
  });
});

import { describe, expect, it } from 'vitest';
import { MAX_CRITIQUES_PER_CRITIC } from './critique';
import { Orchestrator, type RunOutcome } from './engine';
import type { TurnRequest } from './ports';
import { ledgerOf } from './reading';
import {
  critiqueReply,
  fakePorts,
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

const ROSTER = [
  { participantId: ALICE, vendorId: 'anthropic' },
  { participantId: BOB, vendorId: 'openai' },
  { participantId: CARA, vendorId: 'google' },
];

function newPorts(overrides: Partial<Parameters<typeof fakePorts>[0]> = {}): FakePorts {
  return fakePorts({
    sessionId: SESSION,
    roster: ROSTER,
    reply: scriptedReply,
    run: scriptedRun,
    ...overrides,
  });
}

async function throughCritique(ports: FakePorts) {
  const engine = new Orchestrator(ports, { seed: 'test', concurrency: 3 });
  const outcome = (await runPastGates(engine, SESSION)) as RunOutcome;
  const critique = outcome.state.phases.find((phase) => phase.kind === 'CRITIQUE');
  if (!critique) throw new Error(`CRITIQUE never opened: ${outcome.detail}`);
  const ledger = ledgerOf(await ports.snapshot(SESSION));
  const author = ports.asked.find((request) =>
    request.prompt.includes('State what the run found'),
  )!.participantId;
  return { outcome, critique, ledger, author };
}

const critiqueRequests = (ports: FakePorts): TurnRequest[] =>
  ports.asked.filter((request) => request.prompt.includes('Critique the findings'));

/** Every critic replies with the same critiques. */
const critics = (critiques: unknown[]) => ({
  reply: (request: TurnRequest) =>
    request.prompt.includes('Critique the findings')
      ? JSON.stringify({ critiques })
      : scriptedReply(request),
});

const VALID = { claim: 'C1', axis: 'CONFOUNDS', severity: 'major', argument: 'Seed effects.' };

describe('CRITIQUE', () => {
  it('turns each critique into a dispute, attributed to the critic that raised it', async () => {
    const ports = newPorts();
    const { critique, ledger, author } = await throughCritique(ports);

    expect(critique.status).toBe('complete');
    expect(critique.rounds.map((round) => round.mode)).toEqual(['BLIND_PARALLEL']);

    const disputes = ledger.disputes();
    expect(disputes).toHaveLength(2);
    const finding = ledger.claims().find((claim) => claim.claimType === 'EMPIRICAL')!;
    for (const dispute of disputes) {
      expect(dispute.claimId).toBe(finding.claimId);
      expect(dispute.raisedByParticipantId).not.toBe(author);
      expect(dispute.status).toBe('open');
    }
    expect(disputes.map((dispute) => dispute.axis).sort()).toEqual(['BASELINES', 'SCOPE']);
    // The finding is now disputed, and only a dispute could have made it so.
    expect(finding.status).toBe('disputed');
    expect(ledger.rejected).toEqual([]);
  });

  it('staffs the round with every other vendor’s model and never the author (P1)', async () => {
    const ports = newPorts();
    const { critique, author } = await throughCritique(ports);

    const assigned = critique.rounds[0]!.assignments;
    expect(assigned.map((entry) => entry.role)).toEqual(['CRITIC', 'CRITIC']);
    expect(assigned.map((entry) => entry.participantId)).not.toContain(author);
    expect(critiqueRequests(ports).map((request) => request.participantId)).not.toContain(author);
  });

  it('keeps a second model from the author’s vendor out of the critic’s chair', async () => {
    // Rotation is free to pick any author, so check the rule rather than a name.
    const ports = newPorts({
      roster: [...ROSTER, { participantId: DANA, vendorId: 'anthropic', modelId: 'other' }],
    });
    const { critique, author } = await throughCritique(ports);

    const vendorOf = new Map(
      [...ROSTER, { participantId: DANA, vendorId: 'anthropic' }].map((entry) => [
        entry.participantId,
        entry.vendorId,
      ]),
    );
    for (const { participantId } of critique.rounds[0]!.assignments) {
      expect(vendorOf.get(participantId)).not.toBe(vendorOf.get(author));
    }
  });

  it('gives no critic another critic’s view (P3)', async () => {
    const ports = newPorts();
    await throughCritique(ports);

    const requests = critiqueRequests(ports);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.role).toBe('CRITIC');
      expect(request.prompt).toContain('[C1] (EMPIRICAL) The perplexity delta is 0.31');
      expect(request.prompt).toContain('perplexity delta 0.31');
      expect(request.prompt).not.toContain('synthetic corpus says little');
      expect(request.prompt).not.toContain('not compared against a dense baseline');
    }
  });

  it('keeps the test a critic proposed, payload and all', async () => {
    const ports = newPorts();
    const { ledger } = await throughCritique(ports);

    const tests = ledger.disputes().map((dispute) => dispute.proposedTest);
    expect(tests.find((test) => test?.route === 'SANDBOX')).toMatchObject({
      claimFailsIf: 'FAIL',
      code: 'print("SHEEP_TEST: PASS")',
    });
    expect(tests.find((test) => test?.route === 'MANUAL')).toEqual({
      route: 'MANUAL',
      description: 'Repeat on a held-out natural-language corpus.',
    });
  });

  it('reads critiques one by one, so a bad one costs only itself', async () => {
    const ports = newPorts(
      critics([
        VALID,
        { ...VALID, claim: 'C9', argument: 'About a finding that does not exist.' },
        { ...VALID, axis: 'VIBES', argument: 'Along an axis that does not exist.' },
        { claim: 'C1', argument: 'Missing its axis and severity.' },
        // A test in no known shape: the critique stands, with nothing to run.
        { ...VALID, argument: 'With a malformed test.', proposedTest: { route: 'TELEPATHY' } },
        'not even an object',
      ]),
    );
    const { ledger } = await throughCritique(ports);

    const perCritic = ledger.disputes().length / 2;
    expect(perCritic).toBe(2);
    expect(ledger.disputes().map((dispute) => dispute.argument)).toContain(
      'With a malformed test.',
    );
    expect(
      ledger.disputes().find((dispute) => dispute.argument === 'With a malformed test.')!
        .proposedTest,
    ).toBeNull();
  });

  it('caps what one critic can raise', async () => {
    const ports = newPorts(
      critics(Array.from({ length: 9 }, (_, n) => ({ ...VALID, argument: `Point ${String(n)}.` }))),
    );
    const { ledger } = await throughCritique(ports);

    expect(ledger.disputes()).toHaveLength(2 * MAX_CRITIQUES_PER_CRITIC);
  });

  it('accepts that a finding may have nothing wrong with it', async () => {
    const ports = newPorts(critics([]));
    const { critique, ledger } = await throughCritique(ports);

    expect(critique.status).toBe('complete');
    expect(ledger.disputes()).toEqual([]);
    expect(critique.summary).toContain('raised 0 dispute(s)');
  });

  it('ignores a critic that answers in prose, and keeps the others', async () => {
    const ports = newPorts({
      reply: (request) =>
        request.prompt.includes('Critique the findings') && request.participantId !== BOB
          ? 'On the whole the findings seem reasonable.'
          : scriptedReply(request),
    });
    const { ledger } = await throughCritique(ports);

    for (const dispute of ledger.disputes()) expect(dispute.raisedByParticipantId).toBe(BOB);
  });

  it('asks nobody when there were no findings to critique', async () => {
    const ports = newPorts({
      reply: (request) =>
        request.prompt.includes('State what the run found')
          ? '{"findings":[]}'
          : scriptedReply(request),
    });
    const { critique } = await throughCritique(ports);

    expect(critique.status).toBe('complete');
    expect(critique.rounds).toEqual([]);
    expect(critiqueRequests(ports)).toEqual([]);
  });

  it('does not record a critic’s disputes twice when resumed mid-round', async () => {
    const full = newPorts();
    await throughCritique(full);

    // Cut just after the first critic answered: its turn is committed, the
    // round is not closed, and no dispute has been recorded yet.
    const firstCritique = full.events.findIndex(
      (event) =>
        event.type === 'message.recorded' &&
        event.payload.role === 'CRITIC' &&
        event.payload.body.kind === 'text' &&
        event.payload.body.text.includes('"claim"'),
    );
    const reopened = full.fork(full.events.slice(0, firstCritique + 1));
    await new Orchestrator(reopened, { seed: 'test', concurrency: 3 }).run(SESSION);

    expect(critiqueRequests(reopened)).toHaveLength(1);
    expect(ledgerOf(await reopened.snapshot(SESSION)).disputes()).toHaveLength(2);
    expect(critiqueReply(BOB)).toContain('SANDBOX');
  });
});

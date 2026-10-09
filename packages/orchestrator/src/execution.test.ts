import { describe, expect, it } from 'vitest';
import { Orchestrator, type RunOutcome } from './engine';
import { RUN_TIMEOUT_MS, unearnedNumbers } from './execution';
import { ledgerOf } from './reading';
import {
  fakePorts,
  findingsReply,
  runPastGates,
  scriptedReply,
  scriptedRun,
  type FakePorts,
} from './test-support';

const SESSION = '11111111-1111-4111-8111-111111111111';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CARA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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

async function throughExecution(ports: FakePorts) {
  const engine = new Orchestrator(ports, { seed: 'test', concurrency: 3 });
  const outcome = (await runPastGates(engine, SESSION)) as RunOutcome;
  const execution = outcome.state.phases.find((phase) => phase.kind === 'EXECUTION');
  if (!execution) throw new Error(`EXECUTION never opened: ${outcome.detail}`);
  const ledger = ledgerOf(await ports.snapshot(SESSION));
  const findings = ledger.claims().filter((claim) => claim.phaseId === execution.phaseId);
  return { outcome, execution, ledger, findings };
}

const answering = (statements: Parameters<typeof findingsReply>[0]) => ({
  reply: (request: Parameters<typeof scriptedReply>[0]) =>
    request.prompt.includes('State what the run found')
      ? findingsReply(statements)
      : scriptedReply(request),
});

describe('EXECUTION', () => {
  it('runs the method and records each finding against that run', async () => {
    const ports = newPorts();
    const { execution, findings, ledger } = await throughExecution(ports);

    expect(execution.status).toBe('complete');
    expect(findings.map((claim) => claim.claimType)).toEqual(['EMPIRICAL', 'CONJECTURE']);

    // The run every empirical finding rests on is the one that was just made.
    const runs = ports.events.flatMap((event) =>
      event.type === 'execution.recorded' ? [event.payload] : [],
    );
    const final = runs.at(-1)!;
    expect(final.status).toBe('ok');
    expect(findings[0]!.support).toEqual([{ kind: 'EXECUTION', ref: final.executionId }]);
    // An interpretation is recorded as what it is, with no run behind it.
    expect(findings[1]!.support).toEqual([]);
    // Nothing the engine wrote was refused by the ledger's own rules.
    expect(ledger.rejected).toEqual([]);
  });

  it('has the method’s author read the output, and nobody else', async () => {
    const ports = newPorts();
    const { execution, findings } = await throughExecution(ports);

    const [asked] = ports.asked.filter((request) =>
      request.prompt.includes('State what the run found'),
    );
    const author = ports.asked.find((request) =>
      request.prompt.includes('Design the method that will test them'),
    )!.participantId;
    expect(asked!.participantId).toBe(author);
    expect(asked!.prompt).toContain('perplexity delta 0.31');
    expect(execution.rounds[0]!.assignments).toEqual([{ participantId: author, role: 'PROPOSER' }]);
    expect(findings.every((claim) => claim.authorParticipantId === author)).toBe(true);
  });

  it('runs the script in full once, reusing the run METHOD already completed', async () => {
    const ports = newPorts();
    await throughExecution(ports);

    // The draft and the revision were each run once, by METHOD's smoke run.
    // The revision finished, so EXECUTION is handed that run, not a second one.
    expect(ports.ran).toHaveLength(2);

    const slow = newPorts({
      run: (request) =>
        request.timeoutMs === RUN_TIMEOUT_MS ? scriptedRun() : { status: 'timeout' },
    });
    await throughExecution(slow);
    // Still running at the smoke limit, so it is run again with the full clock.
    expect(slow.ran.at(-1)!.timeoutMs).toBe(RUN_TIMEOUT_MS);
  });

  it('refuses a finding that quotes a figure the run never printed', async () => {
    const ports = newPorts(
      answering([
        { statement: 'The perplexity delta is 0.31.', type: 'EMPIRICAL' },
        { statement: 'Retrieval accuracy fell to 71.4%.', type: 'EMPIRICAL' },
        { statement: 'The delta of 0.31 exceeds the 0.02 threshold.', type: 'EMPIRICAL' },
      ]),
    );
    const { execution, findings } = await throughExecution(ports);

    // 0.31 was printed and 0.02 was the method's own stated threshold. 71.4%
    // appears nowhere: it was not measured, so it is not recorded.
    expect(findings.map((claim) => claim.statement)).toEqual([
      'The perplexity delta is 0.31.',
      'The delta of 0.31 exceeds the 0.02 threshold.',
    ]);
    expect(execution.summary).toContain('1 refused');
    expect(execution.summary).toContain('quotes 71.4%, which the run never printed');
  });

  it('asks nobody anything, and claims nothing, when the run fails', async () => {
    const ports = newPorts({
      run: (request) =>
        request.timeoutMs === RUN_TIMEOUT_MS
          ? { status: 'error', stderr: 'MemoryError' }
          : { status: 'timeout' },
    });
    const { outcome, execution, findings } = await throughExecution(ports);

    expect(outcome.status).toBe('failed');
    expect(execution.status).toBe('failed');
    expect(outcome.detail).toContain('nothing can be claimed from it');
    expect(outcome.detail).toContain('MemoryError');
    expect(findings).toEqual([]);
    expect(ports.asked.filter((r) => r.prompt.includes('State what the run found'))).toEqual([]);
  });

  it('records nothing from a reply it cannot read, and says so', async () => {
    const ports = newPorts({
      reply: (request) =>
        request.prompt.includes('State what the run found')
          ? 'The results look promising overall.'
          : scriptedReply(request),
    });
    const { execution, findings } = await throughExecution(ports);

    expect(execution.status).toBe('complete');
    expect(findings).toEqual([]);
    expect(execution.summary).toContain('the findings could not be read');
  });
});

describe('unearned numbers', () => {
  const output = 'accuracy 0.9321\nloss 1.5e-3\nn 200\nshare 0.25\ndelta -0.4';

  it.each([
    ['a figure as printed', 'Accuracy was 0.9321.'],
    ['a figure rounded to fewer places', 'Accuracy was 0.93.'],
    ['a fraction quoted as a percentage', 'Accuracy was 93.2%, on a 25% share.'],
    ['scientific notation', 'Loss was 1.5e-3.'],
    ['a negative figure', 'The delta was -0.4.'],
    ['bare integers, which are not measurements', 'Across 3 seeds and 200 samples it held.'],
    ['a range written with a hyphen', 'It lies in 0.25-0.93.'],
  ])('accepts %s', (_what, statement) => {
    expect(unearnedNumbers(statement, output)).toEqual([]);
  });

  it.each([
    ['a figure that was never printed', 'Accuracy was 0.97.', ['0.97']],
    ['a figure rounded the wrong way', 'Accuracy was 0.94.', ['0.94']],
    ['more precision than was printed', 'The share was 0.2517.', ['0.2517']],
    ['an invented percentage', 'It improved by 12%.', ['12%']],
    ['one invented figure among earned ones', 'From 0.25 to 0.61.', ['0.61']],
  ])('refuses %s', (_what, statement, invented) => {
    expect(unearnedNumbers(statement, output)).toEqual(invented);
  });
});

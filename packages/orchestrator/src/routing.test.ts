import { describe, expect, it } from 'vitest';
import type { ProposedTest } from '@sheep/core';
import { Orchestrator, type RunOutcome } from './engine';
import type { CheckRequest, RunCodeRequest, TurnRequest } from './ports';
import { ledgerOf } from './reading';
import { outcomeOf, TEST_TIMEOUT_MS } from './routing';
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
];

const DERIVATION = {
  given: [{ id: 'g1', statement: 'y = x**2' }],
  steps: [{ id: 's1', statement: 'y = x*x', operation: 'rewrite' }],
};
const CONSTRAINT = {
  name: 'positive',
  variables: { x: 'real' },
  assumptions: [],
  claim: 'x*x >= 0',
};
const STATISTICS = { name: 'study', n: 40, tests: [{ name: 'effect', p: 0.04 }] };

/** A two-model session — one author, one critic — whose critic proposes exactly these tests. */
function sessionWith(
  tests: (Partial<ProposedTest> | null)[],
  overrides: Partial<Parameters<typeof fakePorts>[0]> = {},
): FakePorts {
  const critiques = tests.map((test, index) => ({
    claim: 'C1',
    axis: 'CONFOUNDS',
    severity: 'major',
    argument: `Point ${String(index)}.`,
    ...(test === null ? {} : { proposedTest: { description: 'A test.', ...test } }),
  }));
  return fakePorts({
    sessionId: SESSION,
    roster: ROSTER,
    run: (request) => (request.code.includes('SHEEP_TEST') ? {} : scriptedRun()),
    ...overrides,
    reply: (request: TurnRequest) =>
      request.prompt.includes('Critique the findings')
        ? JSON.stringify({ critiques })
        : scriptedReply(request),
  });
}

async function routed(ports: FakePorts) {
  const engine = new Orchestrator(ports, { seed: 'test' });
  const outcome = (await runPastGates(engine, SESSION)) as RunOutcome;
  const critique = outcome.state.phases.find((phase) => phase.kind === 'CRITIQUE');
  if (!critique) throw new Error(`CRITIQUE never opened: ${outcome.detail}`);
  const ledger = ledgerOf(await ports.snapshot(SESSION));
  return { critique, ledger, disputes: ledger.disputes() };
}

/** A sandbox that prints this as the test script's output. */
const printing = (stdout: string) => ({
  run: (request: RunCodeRequest) =>
    request.code.includes('SHEEP_TEST') ? { stdout } : scriptedRun(),
});

const script = (line = 'PASS'): Partial<ProposedTest> => ({
  route: 'SANDBOX',
  code: `print("SHEEP_TEST: ${line}")`,
});

describe('test auto-routing', () => {
  it('sends each test to the checker its route names, with its payload', async () => {
    const ports = sessionWith([
      script(),
      { route: 'SYMBOLIC', derivation: DERIVATION },
      { route: 'SMT', constraint: CONSTRAINT as never },
      { route: 'STATISTICAL', statistics: STATISTICS },
      { route: 'NUMERIC', code: 'print("SHEEP_TEST: PASS")  # numeric' },
    ]);
    const { disputes, critique } = await routed(ports);

    expect(disputes.map((dispute) => dispute.test?.route)).toEqual([
      'SANDBOX',
      'SYMBOLIC',
      'SMT',
      'STATISTICAL',
      'NUMERIC',
    ]);
    // Scripts went to the sandbox, with the test's own clock...
    const scripts = ports.ran.filter((run) => run.code.includes('SHEEP_TEST'));
    expect(scripts).toHaveLength(2);
    expect(scripts.every((run) => run.timeoutMs === TEST_TIMEOUT_MS)).toBe(true);
    // ...and everything else to a checker, exactly as the critic wrote it.
    expect(ports.checked).toEqual<CheckRequest[]>([
      { kind: 'derivation', derivation: DERIVATION },
      { kind: 'constraint', claim: CONSTRAINT as never },
      { kind: 'statistics', report: STATISTICS },
    ]);
    expect(critique.summary).toContain('5 proposed test(s) were run by a checker');
  });

  it('asks no model what a test showed', async () => {
    const ports = sessionWith([script(), { route: 'SMT', constraint: CONSTRAINT as never }]);
    const before = ports.asked.length;
    await routed(ports);

    // Every turn asked after the critics spoke belongs to a later phase.
    const sinceCritique = ports.asked.slice(
      ports.asked.findLastIndex((request) => request.prompt.includes('Critique the findings')) + 1,
    );
    expect(before).toBe(0);
    expect(sinceCritique.every((request) => !request.prompt.includes('SHEEP_TEST'))).toBe(true);
    expect(sinceCritique.filter((request) => request.role === 'CRITIC')).toEqual([]);
  });

  it('reads a script’s verdict from its last line, and only from there', async () => {
    const lastLine = async (stdout: string) =>
      (await routed(sessionWith([script()], printing(stdout)))).disputes[0]!.test!;

    expect(await lastLine('working...\nSHEEP_TEST: PASS\n')).toMatchObject({ verdict: 'PASS' });
    expect(await lastLine('SHEEP_TEST: FAIL\n')).toMatchObject({ verdict: 'FAIL' });
    // Said earlier and then contradicted by silence: not a verdict.
    expect(await lastLine('SHEEP_TEST: PASS\nactually, not sure\n')).toMatchObject({
      verdict: 'UNCHECKABLE',
      outcome: 'UNRESOLVED',
    });
    expect(await lastLine('the claim looks right to me')).toMatchObject({ verdict: 'UNCHECKABLE' });
    expect(await lastLine('SHEEP_TEST: PASSED')).toMatchObject({ verdict: 'UNCHECKABLE' });
  });

  it('turns a verdict into an outcome by what the critic said would falsify the claim', async () => {
    const { disputes } = await routed(
      sessionWith(
        [
          script('FAIL'),
          { ...script('PASS'), code: 'print("SHEEP_TEST: PASS")  # 2' },
          { ...script('PASS'), code: 'print("SHEEP_TEST: PASS")  # 3', claimFailsIf: 'PASS' },
        ],
        {
          run: (request) =>
            !request.code.includes('SHEEP_TEST')
              ? scriptedRun()
              : { stdout: request.code.includes('FAIL') ? 'SHEEP_TEST: FAIL' : 'SHEEP_TEST: PASS' },
        },
      ),
    );

    expect(disputes.map((dispute) => [dispute.test?.verdict, dispute.test?.outcome])).toEqual([
      // The claim should have passed this test and did not: it is overturned.
      ['FAIL', 'OVERTURNED'],
      // It passed the test it should pass: it is upheld.
      ['PASS', 'UPHELD'],
      // Here passing was the refutation.
      ['PASS', 'OVERTURNED'],
    ]);
    expect(outcomeOf('UNCHECKABLE', 'PASS')).toBe('UNRESOLVED');
  });

  it('cites the run or the stored verdict as evidence', async () => {
    const { disputes, ledger } = await routed(
      sessionWith(
        [script(), { route: 'SMT', constraint: CONSTRAINT as never }],
        printing('SHEEP_TEST: PASS'),
      ),
    );

    const [byScript, bySolver] = disputes.map((dispute) => dispute.test!.evidence);
    expect(byScript?.kind).toBe('EXECUTION');
    expect(bySolver).toMatchObject({ kind: 'ARTIFACT' });
    expect(bySolver!.ref).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger.rejected).toEqual([]);
  });

  it('leaves alone a test with nothing a program can run', async () => {
    const ports = sessionWith([
      { route: 'MANUAL' },
      // A route with no payload is a description of a test, not a test.
      { route: 'SANDBOX' },
      { route: 'SYMBOLIC', code: 'print(1)' },
      null,
    ]);
    const { disputes, critique } = await routed(ports);

    expect(disputes.map((dispute) => dispute.test)).toEqual([null, null, null, null]);
    expect(ports.checked).toEqual([]);
    expect(critique.status).toBe('complete');
    expect(critique.summary).toContain('0 proposed test(s) were run');
  });

  it('records a test that could not be run as undecided, and carries on', async () => {
    const ports = sessionWith(
      [
        script(),
        { route: 'SMT', constraint: CONSTRAINT as never },
        { route: 'SYMBOLIC', derivation: DERIVATION },
      ],
      {
        run: (request) =>
          request.code.includes('SHEEP_TEST')
            ? { status: 'timeout', stderr: 'still going' }
            : scriptedRun(),
        check: (request) => {
          if (request.kind === 'constraint') throw new Error('the sandbox is unavailable');
          return { status: 'UNCHECKABLE', detail: 's1: no checker for the operation' };
        },
      },
    );
    const { disputes, critique } = await routed(ports);

    expect(critique.status).toBe('complete');
    expect(disputes.map((dispute) => dispute.test?.outcome)).toEqual([
      'UNRESOLVED',
      'UNRESOLVED',
      'UNRESOLVED',
    ]);
    expect(disputes[0]!.test).toMatchObject({ verdict: 'UNCHECKABLE', evidence: null });
    expect(disputes[0]!.test!.detail).toContain('did not finish cleanly (timeout)');
    expect(disputes[1]!.test!.detail).toContain('the sandbox is unavailable');
    expect(critique.summary).toContain('0 gave a decisive result');
  });

  it('runs each test once, however often the session is resumed', async () => {
    const full = sessionWith([script(), { route: 'SMT', constraint: CONSTRAINT as never }]);
    await routed(full);

    // Cut immediately after the first test's result was recorded.
    const firstResult = full.events.findIndex((event) => event.type === 'dispute.tested');
    const reopened = full.fork(full.events.slice(0, firstResult + 1));
    await new Orchestrator(reopened, { seed: 'test' }).run(SESSION);

    expect(reopened.events.filter((event) => event.type === 'dispute.tested')).toHaveLength(2);
    expect(reopened.checked).toHaveLength(1);
    expect(reopened.ran.filter((run) => run.code.includes('SHEEP_TEST'))).toEqual([]);
  });
});

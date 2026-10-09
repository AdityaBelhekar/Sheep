import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvent, PHASE_KINDS, type Claim } from '@sheep/core';
import {
  Orchestrator,
  reduceProtocol,
  type OrchestratorPorts,
  type RunOutcome,
  type TurnRequest,
} from '@sheep/orchestrator';
import { framingReply, hypothesisReply, scoringReply } from '@sheep/orchestrator/test-support';
import { devRuntimeDir, locateRuntime, Sandbox } from '@sheep/sandbox';
import {
  getSession,
  listDerivations,
  listExecutions,
  listParticipants,
  openSheepStore,
  readLedger,
  type SheepStore,
} from '@sheep/store';
import { createProtocolServices } from '../src/main/protocol-services';

/**
 * A whole research session, end to end.
 *
 * The models are mocks. Nothing else is: the event log is a real SQLite
 * database with its hash chain, the scripts run in the real sandbox on the
 * bundled interpreter, the checks go to SymPy, Z3 and the statistical audit,
 * and the orchestrator reaches all of it through the same functions the app's
 * main process serves it with. What the mocks say is deliberately ordinary —
 * a small experiment, some fair critiques, one finding that deserves to be
 * refuted — so that what is under test is everything the models do not do.
 */

const ALICE = randomUUID();
const BOB = randomUUID();
const CARA = randomUUID();
const VENDOR: Record<string, string> = { [ALICE]: 'anthropic', [BOB]: 'openai', [CARA]: 'google' };

const FENCE = '```';

/** The experiment: estimate pi by sampling. Seeded by the sandbox, so its output is fixed. */
const SCRIPT = [
  'import numpy as np',
  '',
  'rng = np.random.default_rng()',
  'n = 1000000',
  'points = rng.random((n, 2))',
  'inside = int(((points ** 2).sum(axis=1) <= 1.0).sum())',
  'estimate = 4 * inside / n',
  'print("samples", n)',
  'print("estimate", round(estimate, 4))',
  'print("abs_error", round(abs(estimate - np.pi), 4))',
].join('\n');

const method = (script: string, plan: string): string =>
  [
    JSON.stringify({
      plan,
      analysis: 'An estimate within 0.01 of pi supports H1. An abs_error above 0.01 refutes it.',
      seed: 11,
    }),
    '',
    `${FENCE}python`,
    script,
    FENCE,
  ].join('\n');

/** What the script printed, read off the prompt the way a model would read it. */
const printed = (prompt: string, name: string): string => {
  const value = new RegExp(`^${name} (\\S+)$`, 'm').exec(prompt)?.[1];
  if (value === undefined) throw new Error(`the prompt does not show ${name}`);
  return value;
};

/** Each critic's critiques. Between them: every route, and every way a dispute can end. */
function critique(participantId: string, prompt: string, firstCritic: string): string {
  const estimate = printed(prompt, 'estimate');
  const error = printed(prompt, 'abs_error');
  const critiques =
    participantId === firstCritic
      ? [
          {
            claim: 'C1',
            axis: 'REPRODUCIBILITY',
            severity: 'major',
            argument: 'One sampled estimate could be a fluke; it should agree with quadrature.',
            proposedTest: {
              route: 'SANDBOX',
              description: 'Integrate the quarter circle numerically and compare.',
              falsifies: 'A quadrature value more than 0.01 from the reported estimate.',
              code: [
                'import numpy as np',
                'from scipy import integrate',
                'area, _ = integrate.quad(lambda x: np.sqrt(1 - x * x), 0, 1)',
                `print("SHEEP_TEST: " + ("PASS" if abs(4 * area - ${estimate}) < 0.01 else "FAIL"))`,
              ].join('\n'),
            },
          },
          {
            claim: 'C2',
            axis: 'DERIVATION',
            severity: 'minor',
            argument: 'Check the stated bound actually holds for the printed error.',
            proposedTest: {
              route: 'SMT',
              description: 'The printed error is below the bound.',
              constraint: {
                name: 'error bound',
                variables: { error: 'real' },
                assumptions: [`error == ${error}`],
                claim: 'error < 0.01',
              },
            },
          },
          {
            claim: 'C1',
            axis: 'DERIVATION',
            severity: 'minor',
            argument:
              'The estimator must actually converge to pi: 4 times the quarter-circle area.',
            proposedTest: {
              route: 'SYMBOLIC',
              description: 'Four times the area of a quarter of the unit circle is pi.',
              derivation: {
                given: [
                  { id: 'g1', statement: 'A = pi*r**2/4' },
                  { id: 'g2', statement: 'r = 1' },
                ],
                steps: [
                  {
                    id: 's1',
                    statement: 'A = pi/4',
                    operation: 'substitute',
                    from: 'g1',
                    using: 'g2',
                  },
                  { id: 's2', statement: '4*A = pi', operation: 'multiply', args: { value: '4' } },
                ],
              },
            },
          },
        ]
      : [
          {
            claim: 'C2',
            axis: 'STATISTICS',
            severity: 'blocking',
            argument:
              'A bound on the error is a statistical claim, and one run reports no sample size, interval or effect.',
            proposedTest: {
              route: 'STATISTICAL',
              description: 'Audit what the finding reports about its own uncertainty.',
              statistics: { name: 'error bound', tests: [{ name: 'error below 0.01', p: 0.04 }] },
            },
          },
          {
            claim: 'C1',
            axis: 'SCOPE',
            severity: 'minor',
            argument: 'Agreement at one sample size says nothing about the rate of convergence.',
            proposedTest: {
              route: 'MANUAL',
              description: 'Repeat across sample sizes on hardware this session does not have.',
            },
          },
        ];
  return JSON.stringify({ critiques });
}

const labels = (prompt: string, prefix: string): string[] => [
  ...new Set([...prompt.matchAll(new RegExp(`^\\[(${prefix}\\d+)\\]`, 'gm'))].map((m) => m[1]!)),
];

/** A mock model: answers each kind of prompt the way a competent one would. */
function mockModel(state: { firstCritic: string | null }) {
  return (request: TurnRequest): string => {
    const { prompt, participantId } = request;
    if (prompt.includes('write the problem statement')) return framingReply(participantId);
    if (prompt.includes('Draft the Charter')) {
      return 'QUESTION — can sampling estimate pi to two decimal places?\nSCOPE — one seeded run.\nSUCCESS CRITERIA — an estimate within 0.01 of pi.\nASSUMPTIONS — the generator is uniform.\nOPEN DISAGREEMENTS — none.';
    }
    if (prompt.includes('propose 3 candidate hypotheses')) return hypothesisReply('pi');
    if (prompt.includes('Score each on three axes')) return scoringReply(prompt);
    if (prompt.includes('Design the method that will test them')) {
      // A first draft with a typo in it, so the smoke run has something to catch.
      return method(
        SCRIPT.replace('import numpy as np', 'import numpyy as np'),
        'Sample the unit square.',
      );
    }
    if (prompt.includes('Critique the method before it is run')) {
      return JSON.stringify({
        critiques: [
          { axis: 'POWER', severity: 'minor', argument: 'State the sample size in the output.' },
        ],
      });
    }
    if (prompt.includes('Revise the method')) {
      return method(SCRIPT, 'Sample a million points in the unit square; report the sample size.');
    }
    if (prompt.includes('State what the run found')) {
      return JSON.stringify({
        findings: [
          {
            statement: `The Monte Carlo estimate of pi is ${printed(prompt, 'estimate')}.`,
            type: 'EMPIRICAL',
            confidence: 0.9,
          },
          {
            statement: `The absolute error of the estimate is ${printed(prompt, 'abs_error')}, below 0.01.`,
            type: 'EMPIRICAL',
            confidence: 0.8,
          },
          {
            statement: `The run drew ${printed(prompt, 'samples')} samples.`,
            type: 'EMPIRICAL',
            confidence: 0.99,
          },
          // Not in the output anywhere: this one must be refused.
          {
            statement: 'The estimator converges at a rate of 0.5731 per decade.',
            type: 'EMPIRICAL',
            confidence: 0.6,
          },
          {
            statement: 'More samples would tighten the estimate further.',
            type: 'CONJECTURE',
            confidence: 0.7,
          },
        ],
      });
    }
    if (prompt.includes('Critique the findings')) {
      state.firstCritic ??= participantId;
      return critique(participantId, prompt, state.firstCritic);
    }
    if (prompt.includes('State your final position on each')) {
      return JSON.stringify({
        positions: labels(prompt, 'D').map((dispute) => ({
          dispute,
          confidence: request.role === 'PROPOSER' ? 0.85 : 0.65,
          rationale: `${request.role === 'PROPOSER' ? 'Author' : 'Critic'} position on ${dispute}.`,
        })),
      });
    }
    if (prompt.includes('Write the rationale for each')) {
      return JSON.stringify({
        rationales: labels(prompt, 'D').map((dispute) => ({
          dispute,
          rationale: `Referee rationale for ${dispute}.`,
        })),
      });
    }
    if (prompt.includes('Write the synthesis of this session')) {
      return 'ANSWER — sampling estimates pi to two places in this run.\nWHAT STANDS — C3.\nWHAT WAS REFUTED — C2.\nOPEN QUESTIONS — the rate of convergence, raised against C1.';
    }
    throw new Error(`the mock has no answer for:\n${prompt.slice(0, 300)}`);
  };
}

describe('a full seven-phase session against mock models', () => {
  const root = mkdtempSync(join(tmpdir(), 'sheep-e2e-'));
  let store: SheepStore;
  let outcome: RunOutcome;
  const sessionId = randomUUID();
  const asked: TurnRequest[] = [];

  beforeAll(async () => {
    store = openSheepStore({ dataDir: join(root, 'data') });
    const sandbox = new Sandbox({
      runtime: locateRuntime(devRuntimeDir()),
      root: join(root, 'sandbox'),
    });
    const services = createProtocolServices({ store: () => store, sandbox: () => sandbox });

    store.record([
      domainEvent('session.created', {
        sessionId,
        title: 'Estimating pi by sampling',
        question: 'Can Monte Carlo sampling estimate pi to two decimal places?',
      }),
      ...[ALICE, BOB, CARA].map((participantId) =>
        domainEvent('roster.model-attached', {
          sessionId,
          participantId,
          model: { connectionId: randomUUID(), vendorId: VENDOR[participantId]!, modelId: 'mock' },
          weight: 1,
        }),
      ),
    ]);

    const reply = mockModel({ firstCritic: null });
    const roster = listParticipants(store.db, sessionId, { attachedOnly: true });
    const ports: OrchestratorPorts = {
      snapshot: (id) => Promise.resolve(services.snapshot(id)),
      record: (id, events) => {
        services.record(id, events);
        return Promise.resolve();
      },
      execute: (id, request) => services.execute(id, request),
      check: (id, request) => services.check(id, request),
      newId: () => randomUUID(),
      ask: (_id, request) => {
        asked.push(request);
        const model = roster.find((entry) => entry.participantId === request.participantId)!.model;
        return Promise.resolve({
          text: reply(request),
          model,
          usage: null,
          finish: 'stop' as const,
        });
      },
    };

    // The only two things a person does in the whole session.
    const engine = new Orchestrator(ports, { seed: 'e2e' });
    await engine.run(sessionId);
    await engine.approve(sessionId, { gate: 'charter', decision: 'approved' });
    const option = (await engine.view(sessionId)).phases[1]?.gate?.options[0];
    outcome = await engine.approve(sessionId, {
      gate: 'hypothesis',
      decision: 'approved',
      selected: [option!.optionId],
    });
  }, 600_000);

  afterAll(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const ledger = () => readLedger(store.events, sessionId);
  const finding = (start: string): Claim => {
    const claim = ledger()
      .claims()
      .find((candidate) => candidate.statement.startsWith(start));
    if (!claim) throw new Error(`no finding starts with "${start}"`);
    return claim;
  };
  const disputesOn = (claim: Claim) =>
    ledger()
      .disputes()
      .filter((dispute) => dispute.claimId === claim.claimId);

  it('runs every phase to completion with two human decisions and no others', () => {
    expect(outcome.status, outcome.detail).toBe('complete');
    expect(outcome.state.phases.map((phase) => [phase.kind, phase.status])).toEqual(
      PHASE_KINDS.map((kind) => [kind, 'complete']),
    );
    expect(getSession(store.db, sessionId)?.status).toBe('complete');

    const types = [...store.events.stream({ sessionId })].map((record) => record.type);
    expect(types.filter((type) => type === 'phase.gate-resolved')).toHaveLength(2);
    expect(types.filter((type) => type === 'phase.opened')).toHaveLength(7);
  });

  it('leaves a log whose hash chain verifies and whose ledger refused nothing', () => {
    expect(store.events.verify().ok).toBe(true);
    expect(ledger().rejected).toEqual([]);
    // The protocol state is the log's, not the engine's: rebuilt from disk, it is the same.
    const services = createProtocolServices({ store: () => store, sandbox: () => null as never });
    const rebuilt = reduceProtocol(sessionId, services.snapshot(sessionId).events);
    expect(rebuilt.phases.map((phase) => phase.status)).toEqual(Array(7).fill('complete'));
  });

  it('caught the broken first draft by running it, and ran the revision', () => {
    const [revision] = asked.filter((request) => request.prompt.includes('Revise the method'));
    expect(revision!.prompt).toContain("No module named 'numpyy'");

    const runs = listExecutions(store.db, sessionId);
    expect(runs.some((run) => run.status === 'error')).toBe(true);
    const run = runs.find((candidate) => candidate.seed === 11 && candidate.status === 'ok')!;
    // The real sandbox, the real interpreter, the real output.
    const stdout = store.blobs.readText(run.stdoutHash);
    expect(stdout).toMatch(/^samples 1000000\nestimate 3\.1\d+\nabs_error 0\.00\d+\n$/);
    expect(run.envLockHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('recorded only findings the run earned, each resting on that run', () => {
    const run = listExecutions(store.db, sessionId).find(
      (candidate) => candidate.seed === 11 && candidate.status === 'ok',
    )!;
    const empirical = ledger()
      .claims()
      .filter((claim) => claim.claimType === 'EMPIRICAL');

    expect(empirical).toHaveLength(3);
    for (const claim of empirical) {
      expect(claim.support).toEqual([{ kind: 'EXECUTION', ref: run.executionId }]);
    }
    // The invented convergence rate never reached the ledger, and the log says why.
    expect(
      ledger()
        .claims()
        .some((claim) => claim.statement.includes('0.5731')),
    ).toBe(false);
    const execution = outcome.state.phases.find((phase) => phase.kind === 'EXECUTION');
    expect(execution?.summary).toContain('quotes 0.5731, which the run never printed');
  });

  it('kept every critic on a different vendor from the author it reviewed (P1)', () => {
    const author = finding('The Monte Carlo estimate').authorParticipantId!;
    const critics = asked
      .filter((request) => request.role === 'CRITIC')
      .map((request) => request.participantId);

    expect(new Set(critics).size).toBe(2);
    for (const critic of critics) expect(VENDOR[critic]).not.toBe(VENDOR[author]);
  });

  it('sent every runnable test to its checker and recorded what came back', () => {
    const tested = ledger()
      .disputes()
      .flatMap((dispute) => (dispute.test ? [dispute.test] : []));

    expect(tested.map((test) => [test.route, test.verdict, test.outcome]).sort()).toEqual([
      // Quadrature agrees with the sampled estimate: the finding survives.
      ['SANDBOX', 'PASS', 'UPHELD'],
      // Z3 proves the printed error is under the bound.
      ['SMT', 'PASS', 'UPHELD'],
      // The audit finds no sample size, effect or interval: the finding falls.
      ['STATISTICAL', 'FAIL', 'OVERTURNED'],
      // SymPy checks both steps of the derivation.
      ['SYMBOLIC', 'PASS', 'UPHELD'],
    ]);
    // Every verdict is backed by something in the store that can be read back.
    for (const test of tested) {
      if (test.evidence?.kind === 'ARTIFACT') expect(store.blobs.has(test.evidence.ref)).toBe(true);
    }
    expect(listDerivations(store.db, sessionId).map((record) => record.status)).toEqual(['PASS']);
    expect(tested.find((test) => test.route === 'STATISTICAL')!.detail).toContain('sample-size');
  });

  it('ended each finding where the evidence put it', () => {
    // Survived two tests; one question about it could not be tested here.
    const estimate = finding('The Monte Carlo estimate');
    expect(estimate.status).toBe('unresolved');
    expect(
      disputesOn(estimate)
        .map((dispute) => dispute.status)
        .sort(),
    ).toEqual(['resolved', 'resolved', 'unresolved']);

    // Proved by Z3 and refuted by the audit. One refutation is enough.
    expect(finding('The absolute error').status).toBe('refuted');

    // Nobody disputed it and a run backs it: supported.
    expect(finding('The run drew').status).toBe('supported');
    // An interpretation stays one.
    expect(finding('More samples would').status).toBe('asserted');
  });

  it('preserved both sides of the question it could not settle (P6)', () => {
    const open = ledger()
      .resolutions()
      .filter((resolution) => resolution.outcome === 'UNRESOLVED');

    expect(open).toHaveLength(1);
    expect(open[0]!.positions.map((position) => [position.stance, position.confidence])).toEqual([
      ['SUPPORT', 0.85],
      ['OPPOSE', 0.65],
    ]);
    expect(open[0]!.positions[0]!.rationale).toMatch(/^Author position on D\d\.$/);
    expect(open[0]!.positions[1]!.rationale).toMatch(/^Critic position on D\d\.$/);
    // And no dispute was left without an ending.
    expect(
      ledger()
        .disputes()
        .every((dispute) => dispute.status !== 'open'),
    ).toBe(true);
  });

  it('never let a rationale decide an outcome', () => {
    for (const resolution of ledger().resolutions()) {
      const dispute = ledger()
        .disputes()
        .find((d) => d.disputeId === resolution.disputeId)!;
      expect(resolution.rationale).toMatch(/^Referee rationale for D\d\.$/);
      // Decided disputes carry exactly the outcome their test produced.
      expect(resolution.outcome).toBe(dispute.test?.outcome ?? 'UNRESOLVED');
      if (resolution.outcome !== 'UNRESOLVED') {
        expect(resolution.evidence).toEqual([dispute.test!.evidence]);
      }
    }
  });
});

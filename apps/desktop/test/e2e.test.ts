import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  devToolsDir,
  locateTools,
  matplotlibScript,
  renderGraphviz,
  renderTikz,
} from '@sheep/artifacts';
import { domainEvent, PHASE_KINDS, type Claim } from '@sheep/core';
import {
  Orchestrator,
  reduceProtocol,
  type OrchestratorPorts,
  type RunOutcome,
  type TurnRequest,
} from '@sheep/orchestrator';
import { framingReply, hypothesisReply, scoringReply } from '@sheep/orchestrator/test-support';
import {
  buildDocument,
  buildPaper,
  bundleFiles,
  emitBody,
  emitLatex,
  ProvenanceError,
  templateById,
  TEMPLATES,
  typesetPaper,
  withoutUnprovenanced,
  zip,
  type Block,
  type PaperDocument,
} from '@sheep/paper';
import { admitSource } from '@sheep/retrieval';
import { devRuntimeDir, locateRuntime, Sandbox } from '@sheep/sandbox';
import {
  getSession,
  listDerivations,
  listExecutions,
  listParticipants,
  openSheepStore,
  readLedger,
  recordArtifact,
  recordExecution,
  recordFigures,
  recordRetrieval,
  type SheepStore,
} from '@sheep/store';
import { readPaperSource, readSessionLog } from '../src/main/paper-source';
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

  /**
   * The paper, compiled from that session and from nothing else.
   *
   * Two figures are added first, the two ways a figure comes to rest on a
   * claim: a diagram cited as evidence by a finding, and a plot drawn by a
   * sandbox run that a new claim is backed by.
   */
  describe('the paper compiled from that session', () => {
    const tools = locateTools(devToolsDir());
    let document: PaperDocument;
    let plotClaimId: string;

    const blocksOf = (sectionId: string): readonly Block[] =>
      document.sections.find((section) => section.id === sectionId)?.blocks ?? [];
    const claimLabelled = (label: string): Claim =>
      ledger().claim(document.labels.find((entry) => entry.label === label)!.claimId);

    beforeAll(async () => {
      const supported = ledger()
        .claims()
        .find((claim) => claim.status === 'supported')!;
      const dot = 'digraph { rankdir=LR; samples -> inside -> estimate }';
      const graph = recordArtifact(store, sessionId, {
        artifactId: randomUUID(),
        kind: 'graphviz',
        title: 'How the estimate is formed',
        source: dot,
        ...(await renderGraphviz(tools, dot)),
      });
      store.record([
        domainEvent('claim.evidence-attached', {
          sessionId,
          claimId: supported.claimId,
          evidence: { kind: 'ARTIFACT', ref: graph.artifactId },
        }),
      ]);

      const sandbox = new Sandbox({
        runtime: locateRuntime(devRuntimeDir()),
        root: join(root, 'figure-sandbox'),
      });
      const code = matplotlibScript(
        [
          'import numpy as np',
          'import matplotlib.pyplot as plt',
          'n = np.logspace(2, 6, 20)',
          'plt.loglog(n, 1 / np.sqrt(n))',
          'plt.xlabel("samples")',
        ].join('\n'),
      );
      const run = await sandbox.run({ code, seed: 5 });
      const execution = await recordExecution(store, sessionId, code, run);
      run.dispose();
      recordFigures(store, execution, () => 'Expected error against samples');
      plotClaimId = randomUUID();
      store.record([
        domainEvent('claim.recorded', {
          sessionId,
          claimId: plotClaimId,
          claimType: 'EMPIRICAL',
          statement: 'The expected error of the estimator falls as the inverse square root of n.',
          support: [{ kind: 'EXECUTION', ref: execution.executionId }],
        }),
      ]);

      const picture = '\\draw[->] (0,0) -- node[above] {$n^{-1/2}$} (3,0);';
      const tikz = recordArtifact(store, sessionId, {
        artifactId: randomUUID(),
        kind: 'tikz',
        title: 'The rate, drawn',
        source: picture,
        ...(await renderTikz(tools, picture)),
      });
      store.record([
        domainEvent('claim.evidence-attached', {
          sessionId,
          claimId: plotClaimId,
          evidence: { kind: 'ARTIFACT', ref: tikz.artifactId },
        }),
      ]);

      document = buildDocument(readPaperSource(store, sessionId));
    }, 300_000);

    it('lays the record out in the order it happened, with nothing the ledger does not hold', () => {
      expect(document.sections.map((section) => section.id)).toEqual([
        'question',
        'hypotheses',
        'method',
        'findings',
        'open-questions',
        'other-claims',
        'synthesis',
      ]);
      expect(document.title).toBe('Estimating pi by sampling');
      expect(document.authors.map((author) => author.name).sort()).toEqual(
        Object.values(VENDOR)
          .map((vendor) => `${vendor}/mock`)
          .sort(),
      );

      // Every claim the paper names is a claim in the ledger, under one label.
      const known = new Set(
        ledger()
          .claims()
          .map((claim) => claim.claimId),
      );
      expect(document.labels.every((entry) => known.has(entry.claimId))).toBe(true);
      expect(new Set(document.labels.map((entry) => entry.label)).size).toBe(known.size);
    });

    it('states each finding with the status the evidence gave it, not one it chose', () => {
      const stated = blocksOf('findings').filter((block) => block.kind === 'finding');
      expect(stated.map((block) => block.label)).toEqual(['C1', 'C2', 'C3', 'C4']);
      for (const block of stated) {
        const claim = ledger().claim(block.claimId);
        expect(block.statement).toBe(claim.statement);
        expect(block.status).toBe(claim.status);
      }
      // Three findings the run earned, and one conjecture, labelled as one.
      expect(stated.map((block) => block.status).sort()).toEqual([
        'asserted',
        'refuted',
        'supported',
        'unresolved',
      ]);
      expect(document.abstract.map((sentence) => sentence.text).join(' ')).toContain(
        'Of 4 findings, 1 is supported, 1 refuted and 1 left with an open question.',
      );
    });

    it('quotes the question, the charter and the method from the log, verbatim', () => {
      const quotes = (sectionId: string): string[] =>
        blocksOf(sectionId).flatMap((block) => (block.kind === 'quote' ? [block.text] : []));
      expect(quotes('question')[0]).toBe(
        'Can Monte Carlo sampling estimate pi to two decimal places?',
      );
      expect(quotes('question')).toHaveLength(2);

      const code = blocksOf('method').find((block) => block.kind === 'code');
      // The revision that ran, not the first draft with the typo in it.
      expect(code?.kind === 'code' && code.text).toContain('import numpy as np');
      expect(code?.kind === 'code' && code.text).not.toContain('numpyy');
      const run = blocksOf('method').find((block) => block.kind === 'facts');
      expect(run?.kind === 'facts' && run.facts.find((fact) => fact.term === 'Seed')?.value).toBe(
        '11',
      );
    });

    it('ships the unresolved dispute as an open question, with both positions (P6)', () => {
      const quotes = blocksOf('open-questions').flatMap((block) =>
        block.kind === 'quote' ? [`${block.attribution}: ${block.text}`] : [],
      );
      expect(
        quotes.some((quote) => /support, confidence 0\.85: Author position on D\d\./.test(quote)),
      ).toBe(true);
      expect(
        quotes.some((quote) => /oppose, confidence 0\.65: Critic position on D\d\./.test(quote)),
      ).toBe(true);
      // And it is not also told as if it had been settled.
      const settled = blocksOf('findings')
        .flatMap((block) => (block.kind === 'quote' ? [block.text] : []))
        .join('\n');
      expect(settled).not.toMatch(/Author position on/);
    });

    it('ties each sentence of the synthesis to the findings it names', () => {
      const sentences = blocksOf('synthesis').flatMap((block) =>
        block.kind === 'paragraph' ? block.sentences.filter((sentence) => sentence.asserts) : [],
      );
      const idsOf = (text: string): readonly string[] =>
        sentences.find((sentence) => sentence.text === text)!.claimIds;

      expect(idsOf('C3.')).toEqual([claimLabelled('C3').claimId]);
      expect(idsOf('C2.')).toEqual([claimLabelled('C2').claimId]);
      expect(idsOf('the rate of convergence, raised against C1.')).toEqual([
        claimLabelled('C1').claimId,
      ]);
      // The scribe's one sentence that names no finding has nothing behind it.
      expect(idsOf('sampling estimates pi to two places in this run.')).toEqual([]);
    });

    it('places each figure with the claim it rests on, by content address', () => {
      const figures = document.sections.flatMap((section) =>
        section.blocks.flatMap((block) =>
          block.kind === 'figure' ? [{ section: section.id, ...block }] : [],
        ),
      );
      expect(figures.map((figure) => [figure.section, figure.title, figure.file])).toEqual([
        ['findings', 'How the estimate is formed', 'figures/figure-1.pdf'],
        ['other-claims', 'Expected error against samples', 'figures/figure-2.pdf'],
        ['other-claims', 'The rate, drawn', 'figures/figure-3.pdf'],
      ]);
      expect(figures[0]!.labels).toEqual([
        document.labels.find((entry) => ledger().claim(entry.claimId).status === 'supported')!
          .label,
      ]);
      expect(figures[1]!.labels).toEqual([
        document.labels.find((entry) => entry.claimId === plotClaimId)!.label,
      ]);
      for (const figure of figures) expect(store.blobs.has(figure.hash)).toBe(true);
    });

    it('typesets as a Sheep Research Record, with every claim id in the source', async () => {
      const source = readPaperSource(store, sessionId);
      const template = templateById('sheep');
      const { document: provenanced } = withoutUnprovenanced(document);
      const paper = await typesetPaper(provenanced, template, tools, source.read);

      expect(Buffer.from(paper.pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
      expect(paper.files.map((file) => file.path)).toEqual([
        'paper.tex',
        'figures/figure-1.pdf',
        'figures/figure-2.pdf',
        'figures/figure-3.pdf',
      ]);
      // What a model wrote reached the engine as text, and nothing went missing in it.
      expect(paper.warnings.map((warning) => warning.message).join('\n')).not.toMatch(
        /undefined|Missing character/i,
      );

      const tex = emitLatex(document, template);
      for (const { claimId } of document.labels) expect(tex).toContain(claimId);
      expect(tex).toContain('\\section{Open Questions}');
    }, 300_000);

    it.each(TEMPLATES.filter((template) => template.id !== 'sheep'))(
      'typesets the same record as $label, saying the same thing',
      async (template) => {
        const source = readPaperSource(store, sessionId);
        const { document: provenanced } = withoutUnprovenanced(document);
        const paper = await typesetPaper(provenanced, template, tools, source.read);

        expect(Buffer.from(paper.pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
        expect(paper.warnings.map((warning) => warning.message).join('\n')).not.toMatch(
          /undefined|Missing character/i,
        );
        // The page is the template's. The text is not: every claim is there, under the same id.
        const tex = emitLatex(document, template);
        for (const { claimId } of document.labels) expect(tex).toContain(claimId);
        expect(tex).toContain(emitBody(document));
      },
      300_000,
    );

    it('refuses to build while the scribe’s unlabelled sentence is in it', async () => {
      const source = readPaperSource(store, sessionId);
      const refused = await buildPaper(source, tools, { template: 'sheep' }).catch(
        (error: unknown) => error,
      );

      expect(refused).toBeInstanceOf(ProvenanceError);
      // Exactly the one sentence, named, with where it is and why.
      expect((refused as ProvenanceError).sentences).toEqual([
        {
          section: 'Synthesis',
          text: 'sampling estimates pi to two places in this run.',
          reason: 'it names no claim in the ledger',
        },
      ]);
    });

    it('builds without that sentence when told to, and states the session’s provenance', async () => {
      const source = readPaperSource(store, sessionId);
      const paper = await buildPaper(source, tools, { template: 'sheep', omitUnprovenanced: true });

      expect(paper.omitted.map((sentence) => sentence.text)).toEqual([
        'sampling estimates pi to two places in this run.',
      ]);
      const tex = emitLatex(paper.document, templateById('sheep'));
      expect(tex).not.toContain('sampling estimates pi to two places in this run');
      // The rest of the synthesis is still there.
      expect(tex).toContain('the rate of convergence, raised against C1.');

      const facts = paper.document.appendix.flatMap((section) =>
        section.blocks.flatMap((block) => (block.kind === 'facts' ? block.facts : [])),
      );
      const valuesOf = (term: string): string[] =>
        facts.filter((fact) => fact.term === term).map((fact) => fact.value);

      expect(paper.document.appendix.map((section) => section.id)).toEqual([
        'provenance',
        'provenance-participants',
        'provenance-runs',
        'provenance-derivations',
        'provenance-artifacts',
      ]);
      expect(valuesOf('Root hash')).toEqual([store.events.head()!.entryHash]);
      expect(valuesOf('Left out')[0]).toMatch(/^1 sentence/);
      expect(valuesOf('Tools lock')).toEqual([tools.lockHash]);
      // Every run, with its seed and environment lock; every artifact, with its source.
      const runs = listExecutions(store.db, sessionId);
      expect(valuesOf('Execution').sort()).toEqual(runs.map((run) => run.executionId).sort());
      expect(valuesOf('Seed')).toContain('11');
      expect(new Set(valuesOf('Environment lock'))).toEqual(
        new Set([...runs, ...listDerivations(store.db, sessionId)].map((r) => r.envLockHash)),
      );
      expect(valuesOf('Artifact')).toHaveLength(3);
      expect(valuesOf('Participant').sort()).toEqual([ALICE, BOB, CARA].sort());
    }, 300_000);

    it('emits a bundle whose script redraws every figure from scratch, byte for byte', async () => {
      const source = readPaperSource(store, sessionId);
      const paper = await buildPaper(source, tools, { template: 'sheep', omitUnprovenanced: true });
      const files = bundleFiles(source, paper.document, paper, paper.build, {
        log: readSessionLog(store, sessionId),
        omitted: paper.omitted,
      });

      // Unpacked by another tool, into a directory that holds nothing else.
      const dir = join(root, 'bundle');
      mkdirSync(dir);
      writeFileSync(join(dir, 'bundle.zip'), zip(files));
      const tar = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
      execFileSync(tar, ['-xf', 'bundle.zip'], { cwd: dir });
      // The figures the paper shipped are deleted: nothing can be compared with itself.
      rmSync(join(dir, 'figures'), { recursive: true });

      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
        eventLog: { rootHash: string; entries: number };
        figures: { kind: string; source: string; outputs: unknown[] }[];
        omitted: { text: string }[];
      };
      expect(manifest.eventLog.rootHash).toBe(store.events.head()!.entryHash);
      expect(manifest.figures.map((figure) => figure.kind)).toEqual([
        'graphviz',
        'matplotlib',
        'tikz',
      ]);
      expect(manifest.omitted).toHaveLength(1);
      expect(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(
        manifest.eventLog.entries,
      );
      expect(readFileSync(join(dir, 'paper.pdf')).equals(Buffer.from(paper.pdf))).toBe(true);

      const runtime = locateRuntime(devRuntimeDir());
      const report = execFileSync(
        runtime.python,
        ['reproduce.py', '--dot', tools.dot, '--tectonic', tools.tectonic],
        {
          cwd: dir,
          encoding: 'utf8',
          env: { ...process.env, TECTONIC_CACHE_DIR: tools.texCache },
        },
      );

      const lines = report.split(/\r?\n/).filter((line) => /^[A-Z]+ {2,}figures\//.test(line));
      expect(lines).toHaveLength(3);
      for (const line of lines) expect(line).toMatch(/^IDENTICAL /);
      expect(report).toContain('every redrawn figure is byte-identical');
    }, 600_000);

    it('prints a citation as the source that was retrieved, and refuses one that was not', async () => {
      const cited = (ref: string) =>
        domainEvent('claim.recorded', {
          sessionId,
          claimId: randomUUID(),
          claimType: 'CITED',
          statement: 'Monte Carlo error falls as the inverse square root of the sample count.',
          support: [{ kind: 'CITATION', ref }],
        });
      // A reference written from memory is not a source.
      expect(() => store.record([cited('Metropolis & Ulam (1949)')])).toThrow(
        /LEDGER_UNKNOWN_SOURCE/,
      );

      const source = admitSource(
        {
          provider: 'crossref',
          externalId: '10.2307/2280232',
          title: 'The Monte Carlo Method',
          authors: ['Nicholas Metropolis', 'S. Ulam'],
          year: 1949,
          venue: 'Journal of the American Statistical Association',
          doi: '10.2307/2280232',
          url: 'https://doi.org/10.2307/2280232',
          abstract: null,
        },
        randomUUID(),
      );
      recordRetrieval(store, sessionId, {
        retrievalId: randomUUID(),
        provider: 'crossref',
        query: 'monte carlo method',
        requestUrl: 'https://api.crossref.org/works?query=monte+carlo+method',
        body: '{"message":{"items":[]}}',
        sources: [source],
      });
      store.record([cited(source.sourceId)]);

      const record = readPaperSource(store, sessionId);
      const withCitation = buildDocument(record);
      expect(withCitation.references).toEqual([
        'Nicholas Metropolis and S. Ulam (1949). The Monte Carlo Method. Journal of the American Statistical Association. doi:10.2307/2280232',
      ]);
      const paper = await buildPaper(record, tools, { template: 'sheep', omitUnprovenanced: true });
      const tex = emitLatex(paper.document, templateById('sheep'));
      expect(tex).toContain('\\section*{References}');
      expect(tex).toContain('reference [1]');
      // The cited claim is in the paper as what it is: asserted, never established.
      const stated = paper.document.sections
        .flatMap((section) => section.blocks)
        .find((block) => block.kind === 'finding' && block.claimType === 'CITED');
      expect(stated?.kind === 'finding' && stated.status).toBe('asserted');
    }, 300_000);
  });
});

import { describe, expect, it } from 'vitest';
import { Orchestrator, type RunOutcome } from './engine';
import { finalMethod, MAX_METHOD_DRAFTS, SMOKE_TIMEOUT_MS } from './method';
import type { TurnRequest } from './ports';
import { reduceProtocol } from './state';
import {
  fakePorts,
  methodReply,
  runPastGates,
  scriptedReply,
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
  return fakePorts({ sessionId: SESSION, roster: ROSTER, reply: scriptedReply, ...overrides });
}

const engineOn = (ports: FakePorts): Orchestrator =>
  new Orchestrator(ports, { seed: 'test', concurrency: 3 });

/** Runs a session to wherever it stops after METHOD, and returns the METHOD phase. */
async function throughMethod(ports: FakePorts) {
  const outcome = (await runPastGates(engineOn(ports), SESSION)) as RunOutcome;
  const method = outcome.state.phases.find((phase) => phase.kind === 'METHOD');
  if (!method) throw new Error('METHOD never opened');
  return { outcome, method };
}

const askedIn = (ports: FakePorts, text: string): TurnRequest[] =>
  ports.asked.filter((request) => request.prompt.includes(text));

describe('METHOD', () => {
  it('drafts, is critiqued blind by the other vendors, and is revised by its author', async () => {
    const ports = newPorts();
    const { method } = await throughMethod(ports);

    expect(method.status).toBe('complete');
    expect(method.rounds.map((round) => round.mode)).toEqual([
      'SEQUENTIAL',
      'BLIND_PARALLEL',
      'SEQUENTIAL',
    ]);

    const [draft, critique, revision] = method.rounds;
    const author = draft!.assignments[0]!.participantId;
    expect(draft!.assignments).toEqual([{ participantId: author, role: 'PROPOSER' }]);
    // Everyone else critiques, and the author does not.
    expect(critique!.assignments.map((entry) => entry.role)).toEqual(['CRITIC', 'CRITIC']);
    expect(critique!.assignments.map((entry) => entry.participantId)).not.toContain(author);
    expect(critique!.spoke).toHaveLength(2);
    // The revision is the author's own, whatever rotation would have preferred.
    expect(revision!.assignments).toEqual([{ participantId: author, role: 'PROPOSER' }]);
  });

  it('shows the author what happened when the draft was run, and every critique of it', async () => {
    const ports = newPorts();
    await throughMethod(ports);

    const [revision] = askedIn(ports, 'Revise the method');
    expect(revision!.prompt).toContain('The script ran to completion');
    expect(revision!.prompt).toContain('print("perplexity delta", 0.31)');
    for (const critic of [ALICE, BOB, CARA].filter((id) => id !== revision!.participantId)) {
      expect(revision!.prompt).toContain(`Objection from ${critic.slice(0, 4)}`);
    }
  });

  it('gives no critic another critic’s view (P3)', async () => {
    const ports = newPorts();
    await throughMethod(ports);

    const critiques = askedIn(ports, 'Critique the method before it is run');
    expect(critiques).toHaveLength(2);
    for (const request of critiques) {
      expect(request.role).toBe('CRITIC');
      expect(request.prompt).not.toContain('Objection from');
      expect(request.prompt).toContain('INTERNAL_VALIDITY');
      expect(request.prompt).toContain('REPRODUCIBILITY');
    }
  });

  it('smoke-runs every draft in the sandbox, with the draft’s own seed', async () => {
    const ports = newPorts();
    await throughMethod(ports);

    // Two distinct scripts: the draft and the revision. Re-reading a result
    // on a later step does not run it again.
    expect(ports.ran).toHaveLength(2);
    expect(ports.ran.every((run) => run.seed === 3 && run.timeoutMs === SMOKE_TIMEOUT_MS)).toBe(
      true,
    );
    expect(ports.ran[1]!.code).toContain('dense baseline');
    expect(ports.events.filter((event) => event.type === 'execution.recorded')).toHaveLength(2);
  });

  it('sends a draft that falls over back to its author with the traceback', async () => {
    const ports = newPorts({
      reply: (request) =>
        request.prompt.includes('Design the method that will test them')
          ? methodReply('import numpyy')
          : scriptedReply(request),
      run: (request) =>
        request.code.includes('numpyy')
          ? { status: 'error', stderr: "ModuleNotFoundError: No module named 'numpyy'" }
          : {},
    });
    const { method } = await throughMethod(ports);

    expect(method.status).toBe('complete');
    const [revision] = askedIn(ports, 'Revise the method');
    expect(revision!.prompt).toContain("ModuleNotFoundError: No module named 'numpyy'");
    expect(method.summary).toContain('ran to completion');
  });

  it('has an unreadable draft rewritten before anyone is asked to critique it', async () => {
    let drafts = 0;
    const ports = newPorts({
      reply: (request) => {
        if (request.prompt.includes('Design the method that will test them')) {
          drafts += 1;
          return 'I would compare the two attention patterns on a held-out corpus.';
        }
        return scriptedReply(request);
      },
    });
    const { method } = await throughMethod(ports);

    expect(drafts).toBe(1);
    expect(method.status).toBe('complete');
    // Draft, rewrite, then the critique of something that can be read, then its answer.
    expect(method.rounds.map((round) => round.assignments[0]!.role)).toEqual([
      'PROPOSER',
      'PROPOSER',
      'CRITIC',
      'PROPOSER',
    ]);
    expect(askedIn(ports, 'Revise the method')[0]!.prompt).toContain('The reply could not be read');
  });

  it('closes without a revision when the draft runs and no critic objects', async () => {
    const ports = newPorts({
      reply: (request) =>
        request.prompt.includes('Critique the method before it is run')
          ? '{"critiques":[]}'
          : scriptedReply(request),
    });
    const { method } = await throughMethod(ports);

    expect(method.status).toBe('complete');
    expect(method.rounds).toHaveLength(2);
    expect(askedIn(ports, 'Revise the method')).toEqual([]);
  });

  it('fails, rather than loop, when no draft will run', async () => {
    const ports = newPorts({
      run: () => ({ status: 'error', stderr: 'ZeroDivisionError: division by zero' }),
    });
    const { outcome, method } = await throughMethod(ports);

    expect(outcome.status).toBe('failed');
    expect(method.status).toBe('failed');
    expect(outcome.detail).toContain(
      `no runnable method after ${String(MAX_METHOD_DRAFTS)} drafts`,
    );
    expect(outcome.detail).toContain('ZeroDivisionError');
    expect(method.rounds.filter((round) => round.assignments[0]!.role === 'PROPOSER')).toHaveLength(
      MAX_METHOD_DRAFTS,
    );
  });

  it('treats a script still running at the smoke limit as one that started', async () => {
    const ports = newPorts({ run: () => ({ status: 'timeout' }) });
    const { method } = await throughMethod(ports);

    expect(method.status).toBe('complete');
    expect(method.summary).toContain('still running without error');
  });

  it('refuses to run with nobody from another vendor to critique the method (P1)', async () => {
    const ports = newPorts({
      roster: [
        { participantId: ALICE, vendorId: 'anthropic' },
        { participantId: BOB, vendorId: 'anthropic', modelId: 'another-model' },
      ],
    });
    const { outcome, method } = await throughMethod(ports);

    expect(outcome.status).toBe('failed');
    expect(method.status).toBe('failed');
    expect(outcome.detail).toContain('METHOD cannot be staffed');
  });

  it('ignores a critic that answers in prose, and keeps the others', async () => {
    const ports = newPorts({
      reply: (request) =>
        request.prompt.includes('Critique the method before it is run') &&
        request.participantId === CARA
          ? 'It looks fine to me overall.'
          : scriptedReply(request),
    });
    await throughMethod(ports);

    const [revision] = askedIn(ports, 'Revise the method');
    if (revision!.participantId !== CARA) {
      expect(revision!.prompt.match(/Objection from/g)).toHaveLength(1);
    }
  });

  it('hands later phases the revised method, read back from the log', async () => {
    const ports = newPorts();
    await throughMethod(ports);
    const state = reduceProtocol(SESSION, ports.events);
    const phase = state.phases.find((candidate) => candidate.kind === 'METHOD')!;

    const method = finalMethod(await ports.snapshot(SESSION), phase);
    expect(method.code).toContain('dense baseline');
    expect(method.plan).toContain('five repetitions');
    expect(method.seed).toBe(3);
    expect(method.authorId).toBe([...phase.rounds[0]!.assignments.keys()][0]);
  });

  it('resumes mid-phase without re-asking or re-running what was committed', async () => {
    const full = newPorts();
    await throughMethod(full);

    const methodPhase = reduceProtocol(SESSION, full.events).phases.find(
      (phase) => phase.kind === 'METHOD',
    )?.phaseId;
    // Cut the log just after the critics answered: a crash before the revision.
    const lastCritique = full.events.findLastIndex(
      (event) =>
        event.type === 'message.recorded' &&
        event.payload.role === 'CRITIC' &&
        event.payload.phaseId === methodPhase,
    );
    const reopened = full.fork(full.events.slice(0, lastCritique + 1));
    const resumed = await engineOn(reopened).run(SESSION);

    expect(resumed.state.phases.find((phase) => phase.kind === 'METHOD')?.status).toBe('complete');
    // The critics are not asked again, and neither is the first draft.
    expect(reopened.asked[0]!.prompt).toContain('Revise the method');
    expect(askedIn(reopened, 'Critique the method before it is run')).toEqual([]);
    expect(askedIn(reopened, 'Design the method that will test them')).toEqual([]);
  });
});

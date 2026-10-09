import { describe, expect, it } from 'vitest';
import { Ledger, type DomainEvent } from '@sheep/core';
import { Orchestrator, turnsOf } from './engine';
import type { TurnRequest } from './ports';
import { violations } from './roles';
import { reduceProtocol } from './state';
import { fakePorts, framingReply, scriptedReply, type FakePorts } from './test-support';

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
    ...overrides,
  });
}

function engineOn(ports: FakePorts): Orchestrator {
  return new Orchestrator(ports, { seed: 'test', concurrency: 3 });
}

describe('FRAMING', () => {
  it('runs blind statements, then a charter, then stops at the human gate', async () => {
    const ports = newPorts();
    const outcome = await engineOn(ports).run(SESSION);

    expect(outcome.status).toBe('awaiting-approval');
    const framing = outcome.state.phases[0];
    expect(framing?.kind).toBe('FRAMING');
    expect(framing?.status).toBe('awaiting-approval');
    expect(framing?.gate?.gate).toBe('charter');
    expect(framing?.gate?.proposal).toContain('SUCCESS CRITERIA');

    // Round 0 is blind-parallel and every model answered; round 1 is the
    // referee alone.
    expect(framing?.rounds[0]?.mode).toBe('BLIND_PARALLEL');
    expect(framing?.rounds[0]?.spoke).toHaveLength(3);
    expect(framing?.rounds[1]?.mode).toBe('SEQUENTIAL');
    expect(framing?.rounds[1]?.spoke).toHaveLength(1);
  });

  it('gives each proposer the question and nothing another model wrote (P3)', async () => {
    const ports = newPorts();
    await engineOn(ports).run(SESSION);

    const statements = ports.asked.filter((request) => request.role === 'PROPOSER');
    expect(statements).toHaveLength(3);
    for (const request of statements) {
      for (const participantId of [ALICE, BOB, CARA]) {
        if (participantId === request.participantId) continue;
        expect(request.prompt).not.toContain(framingReply(participantId));
      }
    }
  });

  it('records every transition as an event, in order', async () => {
    const ports = newPorts();
    await engineOn(ports).run(SESSION);

    const types = ports.events.map((event) => event.type);
    expect(types).toEqual([
      'session.created',
      'session.status-changed',
      'phase.opened',
      'round.opened',
      'roster.roles-assigned',
      'message.recorded',
      'message.recorded',
      'message.recorded',
      'round.closed',
      'round.opened',
      'roster.roles-assigned',
      'message.recorded',
      'round.closed',
      'phase.gate-raised',
    ]);
  });

  it('assigns roles legally in every round it opens (P1)', async () => {
    const ports = newPorts();
    const outcome = await engineOn(ports).run(SESSION);
    const participants = ROSTER.map((entry) => ({
      participantId: entry.participantId,
      vendorId: entry.vendorId,
    }));

    for (const phase of outcome.state.phases) {
      for (const round of phase.rounds) {
        expect(violations(round.assignments, { participants, demands: [] })).toEqual([]);
      }
    }
  });

  it('a rejected charter is redrafted with the note, not re-framed from scratch', async () => {
    const ports = newPorts();
    const engine = engineOn(ports);
    await engine.run(SESSION);

    await engine.approve(SESSION, {
      gate: 'charter',
      decision: 'rejected',
      note: 'The scope must exclude encoder-decoder models explicitly.',
    });

    const framing = (await engine.view(SESSION)).phases[0];
    // Statements were not re-run: one blind round, two charter drafts.
    expect(framing?.rounds.map((round) => round.mode)).toEqual([
      'BLIND_PARALLEL',
      'SEQUENTIAL',
      'SEQUENTIAL',
    ]);
    const redraft = ports.asked.filter((request) => request.role === 'REFEREE').at(-1);
    expect(redraft?.prompt).toContain('encoder-decoder');
  });
});

describe('HYPOTHESIS', () => {
  it('generates blind, scores blind, and ranks for a human to choose', async () => {
    const ports = newPorts();
    const engine = engineOn(ports);
    await engine.run(SESSION);
    const outcome = await engine.approve(SESSION, { gate: 'charter', decision: 'approved' });

    expect(outcome.status).toBe('awaiting-approval');
    const hypothesis = outcome.state.phases[1];
    expect(hypothesis?.kind).toBe('HYPOTHESIS');
    expect(hypothesis?.rounds.map((round) => round.mode)).toEqual([
      'BLIND_PARALLEL',
      'BLIND_PARALLEL',
    ]);

    const options = hypothesis?.gate?.options ?? [];
    expect(options.length).toBeGreaterThan(0);
    // Ranked by the blind aggregate, highest first.
    const scores = options.map((option) => option.score ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('no participant sees another’s scores while scoring', async () => {
    const ports = newPorts();
    const engine = engineOn(ports);
    await engine.run(SESSION);
    await engine.approve(SESSION, { gate: 'charter', decision: 'approved' });

    const scoring = ports.asked.filter((request) => request.role === 'VERIFIER');
    expect(scoring).toHaveLength(3);
    for (const request of scoring) {
      // The candidates are visible; nobody else's scoring of them is.
      expect(request.prompt).not.toContain('scored blind');
      expect(request.prompt).not.toContain('"id":"H1","testability":0.9');
      expect(request.prompt).toContain('scores are available to you');
    }
  });

  it('selecting hypotheses completes the phase and hands over to the unattended ones', async () => {
    const ports = newPorts();
    const engine = engineOn(ports);
    await engine.run(SESSION);
    await engine.approve(SESSION, { gate: 'charter', decision: 'approved' });

    const view = await engine.view(SESSION);
    const chosen = view.phases[1]?.gate?.options[0]?.optionId;
    const outcome = await engine.approve(SESSION, {
      gate: 'hypothesis',
      decision: 'approved',
      selected: chosen === undefined ? [] : [chosen],
    });

    expect(outcome.state.phases[1]?.status).toBe('complete');
    // No third gate: METHOD opened and ran without anyone being asked.
    expect(outcome.status).not.toBe('awaiting-approval');
    expect(outcome.state.phases[2]?.kind).toBe('METHOD');
  });

  it('records each selected hypothesis as a CONJECTURE claim with its proposing turn', async () => {
    const ports = newPorts();
    const engine = engineOn(ports);
    await engine.run(SESSION);
    await engine.approve(SESSION, { gate: 'charter', decision: 'approved' });
    const option = (await engine.view(SESSION)).phases[1]?.gate?.options[0];
    await engine.approve(SESSION, {
      gate: 'hypothesis',
      decision: 'approved',
      selected: option === undefined ? [] : [option.optionId],
    });

    const claims = ports.events.flatMap((event) =>
      event.type === 'claim.recorded' ? [event.payload] : [],
    );
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    expect(claim).toMatchObject({ claimType: 'CONJECTURE', statement: option?.label });

    const turn = ports.events.find(
      (event) => event.type === 'message.recorded' && event.payload.messageId === claim?.messageId,
    );
    expect(turn?.type === 'message.recorded' && turn.payload.author).toMatchObject({
      kind: 'MODEL',
      participantId: claim?.authorParticipantId,
    });
    // Recorded in the same batch as the phase closing, and accepted by the ledger.
    const closed = ports.events.findIndex(
      (event) => event.type === 'phase.closed' && event.payload.phaseId === claim?.phaseId,
    );
    expect(ports.events[closed - 1]?.type).toBe('claim.recorded');
    const ledger = new Ledger(SESSION);
    for (const event of ports.events) ledger.apply(event, '2026-09-15T10:00:00.000Z');
    expect(ledger.claims()).toHaveLength(1);
  });

  it('ignores a model that replies in prose instead of JSON', async () => {
    const ports = newPorts({
      reply: (request) =>
        request.participantId === CARA && request.prompt.includes('propose 3 candidate')
          ? 'I would rather explain my reasoning in prose, if that is all right.'
          : scriptedReply(request),
    });
    const engine = engineOn(ports);
    await engine.run(SESSION);
    const outcome = await engine.approve(SESSION, { gate: 'charter', decision: 'approved' });

    // The phase still reaches its gate; the unusable turn stays in the log.
    expect(outcome.status).toBe('awaiting-approval');
    expect((outcome.state.phases[1]?.gate?.options ?? []).length).toBeGreaterThan(0);
  });
});

describe('resume', () => {
  /**
   * The roadmap's bar for Phase 29: "killing the app mid-session and reopening
   * resumes at the last committed turn". A kill is modelled by capping the
   * first engine's steps and then handing its log to a fresh engine with no
   * memory of the run that wrote it — which is exactly what reopening the app
   * gives the orchestrator.
   */
  it('reopening continues from the log rather than starting again', async () => {
    const ports = newPorts();
    const interrupted = await new Orchestrator(ports, { seed: 'test', maxSteps: 2 }).run(SESSION);
    expect(interrupted.status).toBe('stopped');

    const reopened = ports.fork();
    const resumed = await engineOn(reopened).run(SESSION);

    expect(resumed.status).toBe('awaiting-approval');
    // One FRAMING phase, opened once — not reopened by the second engine.
    expect(reopened.events.filter((event) => event.type === 'phase.opened')).toHaveLength(1);
  });

  it('re-asks only the turns that were never committed', async () => {
    const full = newPorts();
    await engineOn(full).run(SESSION);

    // Cut the log immediately after the first two blind turns were recorded:
    // the state a crash between two participants would leave behind.
    const turns: number[] = [];
    full.events.forEach((event, index) => {
      if (event.type === 'message.recorded') turns.push(index);
    });
    const truncated = full.events.slice(0, (turns[1] ?? 0) + 1);

    const reopened = full.fork(truncated);
    const resumed = await engineOn(reopened).run(SESSION);
    expect(resumed.status).toBe('awaiting-approval');

    // Round 0 had three proposers; two were already committed, so exactly one
    // is re-asked rather than all three.
    const reProposed = reopened.asked.filter((request) => request.role === 'PROPOSER');
    expect(reProposed).toHaveLength(1);
    expect(reProposed[0]?.participantId).toBe(CARA);
  });

  it('a second run over a finished gate does not re-ask anything', async () => {
    const ports = newPorts();
    const engine = engineOn(ports);
    await engine.run(SESSION);
    const asked = ports.asked.length;

    await engine.run(SESSION);
    expect(ports.asked.length).toBe(asked);

    const reopened = ports.fork();
    await engineOn(reopened).run(SESSION);
    expect(reopened.asked).toEqual([]);
  });

  it('never calls the same turn twice within a run', async () => {
    const ports = newPorts();
    await engineOn(ports).run(SESSION);

    const keys = ports.asked.map(
      (request) => `${request.roundId}:${request.participantId}:${request.role}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('golden replay', () => {
  /**
   * Phase 29's other bar: "a fixture session replays identically with zero API
   * spend". The fixture is a prompt → answer map captured from a real run; the
   * replay drives the same engine against it, and the two event streams must
   * come out byte-identical — ids included, which is why the harness issues
   * deterministic ones.
   */
  it('replays a recorded session identically, calling no provider', async () => {
    const fixture = new Map<string, string>();
    const recorded = newPorts({
      costPerTurnUsd: 0.01,
      reply: (request) => {
        const answer = scriptedReply(request);
        fixture.set(fixtureKey(request), answer);
        return answer;
      },
    });
    const engine = engineOn(recorded);
    await engine.run(SESSION);
    await engine.approve(SESSION, { gate: 'charter', decision: 'approved' });

    let misses = 0;
    const replayed = newPorts({
      costPerTurnUsd: 0.01,
      reply: (request) => {
        const answer = fixture.get(fixtureKey(request));
        if (answer === undefined) {
          misses += 1;
          return 'FIXTURE MISS';
        }
        return answer;
      },
    });
    const replayEngine = engineOn(replayed);
    await replayEngine.run(SESSION);
    await replayEngine.approve(SESSION, { gate: 'charter', decision: 'approved' });

    // Every prompt the engine built was already in the fixture, so a replay
    // reaches no provider at all — the zero-spend half of the requirement.
    expect(misses).toBe(0);
    expect(replayed.events).toEqual(recorded.events);
    expect(spendOf(replayed.events)).toBe(spendOf(recorded.events));
  });

  it('two runs of the same script produce the same prompt hashes', async () => {
    const first = newPorts();
    const second = newPorts();
    await engineOn(first).run(SESSION);
    await engineOn(second).run(SESSION);

    expect(promptHashes(first.events)).toEqual(promptHashes(second.events));
  });
});

describe('failure handling', () => {
  it('fails the phase, and the session, when every model fails', async () => {
    const ports = newPorts({
      reply: () => {
        throw new Error('provider is down');
      },
    });
    const outcome = await engineOn(ports).run(SESSION);

    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('provider is down');
    expect(outcome.state.phases[0]?.status).toBe('failed');
    expect(outcome.state.status).toBe('failed');
    // The aborted round is closed rather than left open forever.
    expect(outcome.state.phases[0]?.rounds[0]?.status).toBe('aborted');
  });

  it('refuses to run a session with no models attached', async () => {
    const ports = fakePorts({ sessionId: SESSION, roster: [], reply: scriptedReply });
    const outcome = await engineOn(ports).run(SESSION);
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('no models are attached');
  });

  it('stops before a round that would cross the budget cap', async () => {
    const ports = newPorts({ capUsd: 0.05, costPerTurnUsd: 0.02 });
    const outcome = await engineOn(ports).run(SESSION);
    expect(outcome.status).toBe('stopped');
    expect(outcome.reason).toBe('budget');
    expect(outcome.detail).toContain('cap');
  });

  it('cancel stops the loop at the next step, keeping the turns already paid for', async () => {
    const ports = newPorts({
      reply: (request) => {
        // Cancelled from inside the first turn, which is where a user's stop
        // button lands: mid-round, with money already spent.
        engine.cancel(SESSION);
        return scriptedReply(request);
      },
    });
    const engine = engineOn(ports);
    const outcome = await engine.run(SESSION);

    expect(outcome.status).toBe('stopped');
    expect(outcome.reason).toBe('cancelled');
    // The round that was in flight still completed and was recorded.
    expect(outcome.state.phases[0]?.rounds[0]?.spoke).toHaveLength(3);
  });
});

describe('turnsOf', () => {
  it('reads only model text turns from the round asked for', async () => {
    const ports = newPorts();
    await engineOn(ports).run(SESSION);
    const state = reduceProtocol(SESSION, ports.events);
    const round = state.phases[0]?.rounds[0];

    const turns = turnsOf(ports.events, round?.roundId ?? '');
    expect(turns).toHaveLength(3);
    expect(turns.every((turn) => turn.role === 'PROPOSER')).toBe(true);
    expect(turns.every((turn) => turn.promptHash !== null)).toBe(true);
  });
});

/** What a recorded provider fixture is keyed by: the whole request. */
function fixtureKey(request: TurnRequest): string {
  return [request.participantId, request.role, request.system, request.prompt].join('|');
}

function spendOf(events: readonly DomainEvent[]): number {
  return events.reduce(
    (total, event) =>
      event.type === 'session.spend-recorded' ? total + event.payload.costUsd : total,
    0,
  );
}

function promptHashes(events: readonly DomainEvent[]): (string | null)[] {
  return events.flatMap((event) =>
    event.type === 'message.recorded' ? [event.payload.promptHash ?? null] : [],
  );
}

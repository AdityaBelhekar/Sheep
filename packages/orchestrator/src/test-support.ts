import { createHash } from 'node:crypto';
import {
  domainEvent,
  type DomainEvent,
  type ExecutionRecord,
  type ExecutionStatus,
  type RosterEntry,
  type SessionStatus,
} from '@sheep/core';
import type {
  OrchestratorPorts,
  ProgressUpdate,
  RunCodeRequest,
  RunCodeResult,
  SessionSnapshot,
  TurnRequest,
} from './ports';

/**
 * An in-memory session, standing in for the store, the gateway and main.
 *
 * Shipped with the package rather than hidden in a test file because Phase 29's
 * golden replay is this exact object with its script read from a fixture: the
 * harness that proves the protocol works is the harness that replays a recorded
 * session at zero cost, and having two of them would mean the one under test
 * was not the one that ships.
 */

export interface ScriptedTurn {
  /** Returns what the model says. Throw to make the turn fail. */
  (request: TurnRequest, index: number): string | Promise<string>;
}

export interface FakeSessionOptions {
  readonly sessionId?: string;
  /** Distinguishes the ids one fork issues from another's. */
  readonly idPrefix?: number;
  readonly title?: string;
  readonly question?: string;
  readonly roster: readonly { participantId: string; vendorId: string; modelId?: string }[];
  readonly capUsd?: number | null;
  /** What each turn costs. Zero by default, so budget stays out of the way. */
  readonly costPerTurnUsd?: number;
  readonly reply: ScriptedTurn;
  /**
   * Stands in for the sandbox: what a script does when run. A clean run that
   * prints nothing, when absent.
   */
  readonly run?: (request: RunCodeRequest) => {
    status?: ExecutionStatus;
    stdout?: string;
    stderr?: string;
  };
}

export interface FakePorts extends OrchestratorPorts {
  readonly events: readonly DomainEvent[];
  readonly asked: readonly TurnRequest[];
  /** Every script that was actually run, in order. Reused runs are not repeated here. */
  readonly ran: readonly RunCodeRequest[];
  readonly progressLog: readonly ProgressUpdate[];
  /** Ids handed out so far, in order. Deterministic across runs. */
  readonly issuedIds: readonly string[];
  /** A fresh ports object over a log — what "reopening the app" means. */
  fork(events?: readonly DomainEvent[]): FakePorts;
  /** Used by `fork` when it replays an inherited log. */
  setStatus(status: SessionStatus): void;
  addSpend(amount: number): void;
}

const CONNECTION_ID = '00000000-0000-4000-8000-0000000000c0';
const RECORDED_AT = '2026-01-01T00:00:00.000Z';

/**
 * Sequential UUID-shaped ids.
 *
 * Deterministic on purpose: a golden replay compares two event streams, and
 * random ids would make every replay differ from every other for reasons that
 * have nothing to do with the protocol.
 */
export function sequentialIds(prefix = 1): () => string {
  let n = 0;
  return () => {
    n += 1;
    const tail = n.toString(16).padStart(12, '0');
    return `${prefix.toString(16).padStart(8, '0')}-0000-4000-8000-${tail}`;
  };
}

export function fakePorts(options: FakeSessionOptions): FakePorts {
  const sessionId = options.sessionId ?? '11111111-1111-4111-8111-111111111111';
  const events: DomainEvent[] = [];
  const asked: TurnRequest[] = [];
  const ran: RunCodeRequest[] = [];
  const outputs = new Map<string, { stdout: string; stderr: string }>();
  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
  const progressLog: ProgressUpdate[] = [];
  const issuedIds: string[] = [];
  const nextId = sequentialIds(options.idPrefix ?? 1);
  let status: SessionStatus = 'draft';
  let spentUsd = 0;
  let turnIndex = 0;

  const roster: RosterEntry[] = options.roster.map((entry, index) => ({
    participantId: entry.participantId,
    sessionId,
    model: {
      connectionId: CONNECTION_ID,
      vendorId: entry.vendorId,
      modelId: entry.modelId ?? `${entry.vendorId}-model`,
    },
    weight: 1,
    budgetCapUsd: null,
    preferredRole: null,
    attachedAt: `2026-01-01T00:00:0${String(index)}.000Z`,
    detachedAt: null,
  }));

  events.push(
    domainEvent('session.created', {
      sessionId,
      title: options.title ?? 'Test session',
      question: options.question ?? 'Does block-sparse attention preserve perplexity at 128k?',
    }),
  );

  const ports: FakePorts = {
    get events() {
      return events;
    },
    get asked() {
      return asked;
    },
    get ran() {
      return ran;
    },
    get progressLog() {
      return progressLog;
    },
    get issuedIds() {
      return issuedIds;
    },
    fork(seed?: readonly DomainEvent[]) {
      // A different id prefix, because the fork is a different process: it must
      // not reissue ids the log it inherited already contains.
      const forked = fakePorts({ ...options, idPrefix: (options.idPrefix ?? 1) + 1 });
      const log = forked.events as DomainEvent[];
      log.length = 0;
      log.push(...(seed ?? events));
      for (const event of log) {
        if (event.type === 'session.status-changed') forked.setStatus(event.payload.status);
        if (event.type === 'session.spend-recorded') forked.addSpend(event.payload.costUsd);
      }
      return forked;
    },
    setStatus(next: SessionStatus) {
      status = next;
    },
    addSpend(amount: number) {
      spentUsd += amount;
    },
    snapshot(id: string): Promise<SessionSnapshot> {
      if (id !== sessionId) return Promise.reject(new Error(`unknown session: ${id}`));
      return Promise.resolve({
        sessionId,
        title: options.title ?? 'Test session',
        question: options.question ?? 'Does block-sparse attention preserve perplexity at 128k?',
        status,
        budget: { capUsd: options.capUsd ?? null, spentUsd },
        roster,
        events: [...events],
      });
    },
    record(_id: string, batch: readonly DomainEvent[]): Promise<void> {
      for (const event of batch) {
        events.push(event);
        if (event.type === 'session.status-changed') status = event.payload.status;
        if (event.type === 'session.spend-recorded') spentUsd += event.payload.costUsd;
      }
      return Promise.resolve();
    },
    async ask(_id: string, request: TurnRequest) {
      asked.push(request);
      const participant = roster.find((entry) => entry.participantId === request.participantId);
      if (!participant) throw new Error(`unknown participant: ${request.participantId}`);
      const text = await options.reply(request, turnIndex++);
      const cost = options.costPerTurnUsd ?? 0;
      return {
        text,
        model: participant.model,
        usage: { inputTokens: 100, outputTokens: 200, costUsd: cost },
        finish: 'stop' as const,
      };
    },
    execute(_id: string, request: RunCodeRequest): Promise<RunCodeResult> {
      const codeHash = sha256(request.code);
      const seed = request.seed ?? 0;
      // As the real sandbox port does: a clean run of the same code with the
      // same seed is returned again, not repeated.
      for (const event of events) {
        if (event.type !== 'execution.recorded') continue;
        const prior = event.payload;
        const output = outputs.get(prior.executionId);
        if (prior.codeHash === codeHash && prior.seed === seed && prior.status === 'ok' && output) {
          return Promise.resolve({
            execution: { ...prior, peakMemoryBytes: null, recordedAt: RECORDED_AT },
            ...output,
          });
        }
      }

      ran.push(request);
      const outcome = options.run?.(request) ?? {};
      const status = outcome.status ?? 'ok';
      const output = { stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' };
      const payload = {
        sessionId,
        executionId: nextId(),
        codeHash,
        exitCode: status === 'ok' ? 0 : status === 'error' ? 1 : -1,
        status,
        seed,
        envLockHash: sha256('fake runtime'),
        limits: { memoryMb: 1024, cpuPercent: 50, timeoutMs: request.timeoutMs ?? 60_000 },
        durationMs: 12,
        stdoutHash: sha256(output.stdout),
        stderrHash: sha256(output.stderr),
        truncated: false,
        artifacts: [],
      };
      events.push(domainEvent('execution.recorded', payload));
      outputs.set(payload.executionId, output);
      const execution: ExecutionRecord = {
        ...payload,
        peakMemoryBytes: null,
        recordedAt: RECORDED_AT,
      };
      return Promise.resolve({ execution, ...output });
    },
    newId() {
      const id = nextId();
      issuedIds.push(id);
      return id;
    },
    progress(update: ProgressUpdate) {
      progressLog.push(update);
    },
  };
  return ports;
}

/** A framing statement that is distinct per participant, so clustering has work to do. */
export function framingReply(participantId: string): string {
  const angles = [
    'Scope: decoder-only transformers below two billion parameters, evaluated at 128k tokens. ' +
      'An answer is a measured perplexity delta with a stated confidence interval.',
    'The real variable is the sparsity pattern, not the context length. Retrieval accuracy ' +
      'should be measured alongside, because aggregate scores hide positional failures.',
    'Framing this as a cost question: what compute budget buys what quality, and where the ' +
      'curve crosses dense attention at equal wall-clock time.',
  ];
  const angle = angles[participantId.charCodeAt(0) % angles.length] ?? angles[0];
  return `Problem statement from ${participantId}. ${String(angle)}`;
}

/** A hypothesis reply in the JSON shape the prompt asks for. */
export function hypothesisReply(seed: string): string {
  return JSON.stringify({
    hypotheses: [
      {
        label: `Block-sparse attention costs under two percent perplexity at 128k (${seed})`,
        detail: 'Measured against dense attention on a held-out corpus with a fixed token budget.',
      },
      {
        label: `Sparsity harms retrieval accuracy before it harms perplexity (${seed})`,
        detail: 'Needle-in-a-haystack retrieval degrades earlier than aggregate perplexity does.',
      },
    ],
  });
}

/** Scores for every candidate the scoring prompt listed. */
export function scoringReply(prompt: string): string {
  const ids = [...prompt.matchAll(/^\[(H\d+)\]/gm)].map((match) => match[1] ?? '');
  return JSON.stringify({
    scores: ids.map((id, index) => ({
      id,
      testability: 0.9 - index * 0.1,
      novelty: 0.6,
      feasibility: 0.8 - index * 0.05,
      note: 'scored blind',
    })),
  });
}

// ---------------------------------------------------------------------------
// A whole scripted session
// ---------------------------------------------------------------------------

const FENCE = '```';

/** A method reply in the shape the prompt asks for: a JSON object, then a fenced script. */
export function methodReply(
  script = 'import numpy as np\nprint("perplexity delta", 0.31)',
  plan = 'Compare block-sparse with dense attention on a synthetic corpus.',
): string {
  return [
    JSON.stringify({
      plan,
      analysis: 'A printed delta under 0.02 supports H1; anything above it refutes H1.',
      seed: 3,
    }),
    '',
    `${FENCE}python`,
    script,
    FENCE,
  ].join('\n');
}

/** One critique per critic, on an axis that differs by critic so they are told apart. */
export function methodCritiqueReply(participantId: string): string {
  const axis = participantId.charCodeAt(0) % 2 === 0 ? 'BASELINES' : 'POWER';
  return JSON.stringify({
    critiques: [
      {
        axis,
        severity: 'major',
        argument: `Objection from ${participantId.slice(0, 4)}: the ${axis.toLowerCase()} are not addressed.`,
      },
    ],
  });
}

/** What the scripted method prints when it is run. */
export function scriptedRun(): { stdout: string } {
  return { stdout: 'dense baseline 0.0\nperplexity delta 0.31\n' };
}

/** Findings in the shape the prompt asks for. One measured, one interpreted, by default. */
export function findingsReply(
  findings: readonly { statement: string; type: 'EMPIRICAL' | 'CONJECTURE' }[] = [
    { statement: 'The perplexity delta is 0.31, above the 0.02 threshold.', type: 'EMPIRICAL' },
    { statement: 'Sparsity probably harms long-range retrieval first.', type: 'CONJECTURE' },
  ],
): string {
  return JSON.stringify({
    findings: findings.map((finding) => ({ ...finding, hypothesis: 'H1', confidence: 0.7 })),
  });
}

/**
 * Answers every prompt a session can ask.
 *
 * Keyed off what the prompt asks for rather than off a call counter, so the
 * script does not silently go out of step when the engine reorders or retries a
 * turn — which is exactly what a resume makes it do.
 */
export function scriptedReply(request: TurnRequest): string {
  const { prompt, participantId } = request;
  if (prompt.includes('write the problem statement')) return framingReply(participantId);
  if (prompt.includes('Draft the Charter')) {
    return [
      'QUESTION — does block-sparse attention preserve perplexity at 128k?',
      'SCOPE — decoder-only models under two billion parameters.',
      'SUCCESS CRITERIA — a measured perplexity delta with a confidence interval.',
      'ASSUMPTIONS — the sparsity pattern is fixed rather than learned.',
      'OPEN DISAGREEMENTS — whether retrieval accuracy counts as in scope.',
    ].join('\n');
  }
  if (prompt.includes('propose 3 candidate hypotheses')) {
    return hypothesisReply(participantId.slice(0, 4));
  }
  if (prompt.includes('Score each on three axes')) return scoringReply(prompt);
  if (prompt.includes('State what the run found')) return findingsReply();
  if (prompt.includes('Critique the method before it is run')) {
    return methodCritiqueReply(participantId);
  }
  if (prompt.includes('Revise the method')) {
    return methodReply(
      'import numpy as np\nprint("dense baseline", 0.0)\nprint("perplexity delta", 0.31)',
      'As before, now with a dense baseline and five repetitions.',
    );
  }
  if (prompt.includes('Design the method that will test them')) return methodReply();
  throw new Error(`the script has no answer for this prompt:\n${prompt.slice(0, 200)}`);
}

/**
 * Drives a session through both human gates, choosing the top-ranked
 * hypothesis, and returns where the unattended phases then stopped.
 */
export async function runPastGates(
  engine: {
    run(sessionId: string): Promise<unknown>;
    approve(
      sessionId: string,
      input: { gate: 'charter' | 'hypothesis'; decision: 'approved'; selected?: string[] },
    ): Promise<unknown>;
    view(sessionId: string): Promise<{
      phases: { gate: { options: { optionId: string }[] } | null }[];
    }>;
  },
  sessionId: string,
): Promise<unknown> {
  await engine.run(sessionId);
  await engine.approve(sessionId, { gate: 'charter', decision: 'approved' });
  const option = (await engine.view(sessionId)).phases[1]?.gate?.options[0];
  if (!option) throw new Error('the hypothesis gate offered nothing to select');
  return await engine.approve(sessionId, {
    gate: 'hypothesis',
    decision: 'approved',
    selected: [option.optionId],
  });
}

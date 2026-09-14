import { domainEvent, type DomainEvent, type RosterEntry, type SessionStatus } from '@sheep/core';
import type { OrchestratorPorts, ProgressUpdate, SessionSnapshot, TurnRequest } from './ports';

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
}

export interface FakePorts extends OrchestratorPorts {
  readonly events: readonly DomainEvent[];
  readonly asked: readonly TurnRequest[];
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

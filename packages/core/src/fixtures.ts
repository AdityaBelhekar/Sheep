import type { DomainEventType, EventPayload } from './events';
import type { ModelRef } from './model';

/**
 * One valid payload for every event type.
 *
 * Exported rather than kept in the test file because later phases need a
 * realistic log to replay: projections (Phase 8), the golden-replay harness
 * (Phase 29) and the end-to-end fixtures all want the same known-good corpus.
 *
 * The mapped type is the point — adding an event type without adding a fixture
 * here is a compile error, so the round-trip suite can never silently stop
 * covering something.
 */
export type EventFixtures = { readonly [T in DomainEventType]: EventPayload<T> };

export const SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const PHASE_ID = '22222222-2222-4222-8222-222222222222';
export const ROUND_ID = '33333333-3333-4333-8333-333333333333';
export const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
export const CLAIM_ID = '55555555-5555-4555-8555-555555555555';
export const DISPUTE_ID = '66666666-6666-4666-8666-666666666666';
export const PARTICIPANT_A = '77777777-7777-4777-8777-777777777777';
export const PARTICIPANT_B = '88888888-8888-4888-8888-888888888888';
export const CONNECTION_ID = '99999999-9999-4999-8999-999999999999';
export const CONNECTION_ID_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const OPTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const EXECUTION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const DERIVATION_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export const ANTHROPIC_MODEL: ModelRef = {
  connectionId: CONNECTION_ID,
  vendorId: 'anthropic',
  modelId: 'claude-opus-5',
  version: 'claude-opus-5-20260401',
};

export const OPENAI_MODEL: ModelRef = {
  connectionId: CONNECTION_ID_B,
  vendorId: 'openai',
  modelId: 'gpt-5',
};

const EMPTY_SHA = '0'.repeat(64);
const PROMPT_HASH = 'a'.repeat(64);

export const EVENT_FIXTURES: EventFixtures = {
  'app.started': {
    version: '0.0.0',
    platform: 'win32',
    electron: '43.4.0',
  },

  'session.created': {
    sessionId: SESSION_ID,
    title: 'Sparse attention scaling',
    question: 'Does block-sparse attention preserve perplexity at 128k context?',
  },
  'session.retitled': {
    sessionId: SESSION_ID,
    title: 'Block-sparse attention at long context',
  },
  'session.question-revised': {
    sessionId: SESSION_ID,
    question: 'Does block-sparse attention preserve perplexity at 128k context on held-out text?',
  },
  'session.status-changed': {
    sessionId: SESSION_ID,
    status: 'running',
    reason: 'charter approved by the user',
  },
  'session.budget-set': { sessionId: SESSION_ID, capUsd: 25 },
  'session.spend-recorded': {
    sessionId: SESSION_ID,
    costUsd: 0.0412,
    messageId: MESSAGE_ID,
  },

  'roster.model-attached': {
    sessionId: SESSION_ID,
    participantId: PARTICIPANT_A,
    model: ANTHROPIC_MODEL,
    weight: 1,
    budgetCapUsd: 10,
    preferredRole: 'PROPOSER',
  },
  'roster.model-reconfigured': {
    sessionId: SESSION_ID,
    participantId: PARTICIPANT_A,
    weight: 1.5,
    budgetCapUsd: 4,
    preferredRole: 'CRITIC',
  },
  'roster.model-detached': {
    sessionId: SESSION_ID,
    participantId: PARTICIPANT_B,
    reason: 'provider unavailable',
  },
  'roster.roles-assigned': {
    sessionId: SESSION_ID,
    phaseId: PHASE_ID,
    roundId: ROUND_ID,
    assignments: [
      { participantId: PARTICIPANT_A, role: 'PROPOSER' },
      { participantId: PARTICIPANT_B, role: 'CRITIC' },
    ],
  },

  'phase.opened': {
    sessionId: SESSION_ID,
    phaseId: PHASE_ID,
    kind: 'FRAMING',
    index: 0,
  },
  'phase.closed': {
    sessionId: SESSION_ID,
    phaseId: PHASE_ID,
    outcome: 'complete',
    summary: 'Charter approved with two scope restrictions.',
  },

  'phase.gate-raised': {
    sessionId: SESSION_ID,
    phaseId: PHASE_ID,
    gate: 'charter',
    proposal: 'Charter: measure perplexity at 128k under three sparsity patterns.',
    options: [
      {
        optionId: OPTION_ID,
        label: 'Block-sparse preserves perplexity within 2%',
        detail: 'Testable on a 1.3B model at 128k with a fixed token budget.',
        score: 0.72,
      },
    ],
  },
  'phase.gate-resolved': {
    sessionId: SESSION_ID,
    phaseId: PHASE_ID,
    gate: 'charter',
    decision: 'approved',
    selected: [OPTION_ID],
    note: 'Scope restricted to decoder-only models.',
  },

  'round.opened': {
    sessionId: SESSION_ID,
    phaseId: PHASE_ID,
    roundId: ROUND_ID,
    index: 0,
    mode: 'BLIND_PARALLEL',
  },
  'round.closed': {
    sessionId: SESSION_ID,
    phaseId: PHASE_ID,
    roundId: ROUND_ID,
    outcome: 'complete',
  },

  'message.recorded': {
    sessionId: SESSION_ID,
    messageId: MESSAGE_ID,
    phaseId: PHASE_ID,
    roundId: ROUND_ID,
    author: { kind: 'MODEL', participantId: PARTICIPANT_A, model: ANTHROPIC_MODEL },
    role: 'PROPOSER',
    body: { kind: 'text', text: 'Perplexity degrades by 0.3 nats beyond 64k tokens.' },
    usage: { inputTokens: 1_204, outputTokens: 318, cachedInputTokens: 900, costUsd: 0.0412 },
    finish: 'stop',
    promptHash: PROMPT_HASH,
  },

  'execution.recorded': {
    sessionId: SESSION_ID,
    executionId: EXECUTION_ID,
    codeHash: PROMPT_HASH,
    exitCode: 0,
  },
  'derivation.recorded': {
    sessionId: SESSION_ID,
    derivationId: DERIVATION_ID,
    bodyHash: PROMPT_HASH,
  },

  'claim.recorded': {
    sessionId: SESSION_ID,
    claimId: CLAIM_ID,
    claimType: 'EMPIRICAL',
    statement: 'Block-sparse attention raises perplexity by 0.3 nats at 128k context.',
    phaseId: PHASE_ID,
    messageId: MESSAGE_ID,
    authorParticipantId: PARTICIPANT_A,
    confidence: 0.62,
    support: [{ kind: 'EXECUTION', ref: EXECUTION_ID, note: 'run on held-out WikiText' }],
  },
  'claim.evidence-attached': {
    sessionId: SESSION_ID,
    claimId: CLAIM_ID,
    evidence: { kind: 'ARTIFACT', ref: EMPTY_SHA },
  },
  'claim.status-changed': {
    sessionId: SESSION_ID,
    claimId: CLAIM_ID,
    status: 'disputed',
    reason: 'no baseline reported',
  },

  'dispute.opened': {
    sessionId: SESSION_ID,
    disputeId: DISPUTE_ID,
    claimId: CLAIM_ID,
    axis: 'BASELINES',
    severity: 'blocking',
    argument: 'The dense-attention control was never run, so the delta has no referent.',
    raisedByParticipantId: PARTICIPANT_B,
    proposedTest: {
      route: 'SANDBOX',
      description: 'Run the dense baseline at 128k and report both perplexities.',
      falsifies: 'A dense baseline within 0.05 nats would refute the claimed gap.',
    },
  },
  'dispute.resolved': {
    sessionId: SESSION_ID,
    disputeId: DISPUTE_ID,
    outcome: 'UNRESOLVED',
    rationale: 'No available run discriminates the two positions at this context length.',
    evidence: [{ kind: 'EXECUTION', ref: 'exec-0002' }],
    resolvedByParticipantId: PARTICIPANT_A,
    positions: [
      { participantId: PARTICIPANT_A, stance: 'SUPPORT', confidence: 0.62 },
      {
        participantId: PARTICIPANT_B,
        stance: 'OPPOSE',
        confidence: 0.55,
        rationale: 'Effect is within run-to-run variance.',
      },
    ],
  },
  'dispute.withdrawn': {
    sessionId: SESSION_ID,
    disputeId: DISPUTE_ID,
    reason: 'the baseline was in fact reported in the appendix',
  },
};

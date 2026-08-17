import { describe, expect, it } from 'vitest';
import {
  CLAIM_TYPES,
  REQUIRED_EVIDENCE_KIND,
  canEstablishAlone,
  claimSchema,
  type Claim,
} from './claim';
import { disputeSchema, resolutionSchema, type Dispute, type Resolution } from './dispute';
import { messageSchema, type Message } from './message';
import { rosterEntrySchema, type RosterEntry } from './model';
import { sha256Schema, timestampSchema } from './primitives';
import { phaseSchema, roundSchema, type Phase, type Round } from './protocol';
import { SESSION_STATUSES, isTerminalSessionStatus, sessionSchema, type Session } from './session';
import {
  ANTHROPIC_MODEL,
  CLAIM_ID,
  DISPUTE_ID,
  MESSAGE_ID,
  PARTICIPANT_A,
  PARTICIPANT_B,
  PHASE_ID,
  ROUND_ID,
  SESSION_ID,
} from './fixtures';

const NOW = '2026-08-17T09:12:33.041Z';

const session: Session = {
  sessionId: SESSION_ID,
  title: 'Block-sparse attention at long context',
  question: 'Does block-sparse attention preserve perplexity at 128k context?',
  status: 'running',
  budget: { capUsd: 25, spentUsd: 1.42 },
  createdAt: NOW,
  updatedAt: NOW,
};

const rosterEntry: RosterEntry = {
  participantId: PARTICIPANT_A,
  sessionId: SESSION_ID,
  model: ANTHROPIC_MODEL,
  weight: 1,
  attachedAt: NOW,
  detachedAt: null,
};

const phase: Phase = {
  phaseId: PHASE_ID,
  sessionId: SESSION_ID,
  kind: 'CRITIQUE',
  index: 4,
  status: 'running',
  openedAt: NOW,
  closedAt: null,
};

const round: Round = {
  roundId: ROUND_ID,
  phaseId: PHASE_ID,
  sessionId: SESSION_ID,
  index: 0,
  mode: 'BLIND_PARALLEL',
  status: 'open',
  openedAt: NOW,
  closedAt: null,
};

const message: Message = {
  messageId: MESSAGE_ID,
  sessionId: SESSION_ID,
  phaseId: PHASE_ID,
  roundId: ROUND_ID,
  author: { kind: 'MODEL', participantId: PARTICIPANT_A, model: ANTHROPIC_MODEL },
  role: 'CRITIC',
  body: { kind: 'text', text: 'The baseline is missing.' },
  usage: { inputTokens: 900, outputTokens: 120, costUsd: 0.02 },
  promptHash: 'c'.repeat(64),
  recordedAt: NOW,
};

const claim: Claim = {
  claimId: CLAIM_ID,
  sessionId: SESSION_ID,
  phaseId: PHASE_ID,
  authorParticipantId: PARTICIPANT_A,
  claimType: 'EMPIRICAL',
  statement: 'Perplexity rises 0.3 nats at 128k context.',
  status: 'disputed',
  confidence: 0.62,
  support: [{ kind: 'EXECUTION', ref: 'exec-0001' }],
  recordedAt: NOW,
  updatedAt: NOW,
};

const dispute: Dispute = {
  disputeId: DISPUTE_ID,
  sessionId: SESSION_ID,
  claimId: CLAIM_ID,
  raisedByParticipantId: PARTICIPANT_B,
  axis: 'BASELINES',
  severity: 'blocking',
  argument: 'No dense control was run.',
  proposedTest: { route: 'SANDBOX', description: 'Run the dense baseline at 128k.' },
  status: 'open',
  openedAt: NOW,
  resolvedAt: null,
};

const resolution: Resolution = {
  disputeId: DISPUTE_ID,
  outcome: 'UNRESOLVED',
  rationale: 'No run discriminates the positions.',
  evidence: [],
  resolvedByParticipantId: null,
  positions: [{ participantId: PARTICIPANT_A, stance: 'SUPPORT', confidence: 0.62 }],
  resolvedAt: NOW,
};

const ENTITIES = [
  ['session', sessionSchema, session],
  ['rosterEntry', rosterEntrySchema, rosterEntry],
  ['phase', phaseSchema, phase],
  ['round', roundSchema, round],
  ['message', messageSchema, message],
  ['claim', claimSchema, claim],
  ['dispute', disputeSchema, dispute],
  ['resolution', resolutionSchema, resolution],
] as const;

describe.each(ENTITIES)('%s', (_name, schema, value) => {
  it('round-trips through JSON unchanged', () => {
    const wire = JSON.parse(JSON.stringify(value)) as unknown;
    const parsed = schema.parse(wire);
    expect(parsed).toEqual(value);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(value));
  });

  it('rejects an unknown column', () => {
    expect(schema.safeParse({ ...value, extra: 1 }).success).toBe(false);
  });

  it('rejects a missing required field', () => {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const partial = { ...(value as Record<string, unknown>) };
      delete partial[key];
      expect(schema.safeParse(partial).success, `${key} should be required`).toBe(false);
    }
  });
});

describe('primitives', () => {
  it('accepts only UTC ISO-8601 timestamps with milliseconds', () => {
    expect(timestampSchema.safeParse(NOW).success).toBe(true);
    expect(timestampSchema.safeParse(new Date().toISOString()).success).toBe(true);
    for (const bad of [
      '2026-08-17T09:12:33.041+01:00',
      '2026-08-17 09:12:33Z',
      '2026-08-17',
      '',
      'now',
    ]) {
      expect(timestampSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('accepts only lower-case sha-256 digests', () => {
    expect(sha256Schema.safeParse('a'.repeat(64)).success).toBe(true);
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '']) {
      expect(sha256Schema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('claim rules vocabulary', () => {
  it('says which claim types can establish a conclusion alone', () => {
    expect(canEstablishAlone('DERIVED')).toBe(true);
    expect(canEstablishAlone('EMPIRICAL')).toBe(true);
    expect(canEstablishAlone('CITED')).toBe(false);
    expect(canEstablishAlone('CONJECTURE')).toBe(false);
  });

  it('names a required evidence kind for every claim type', () => {
    expect(Object.keys(REQUIRED_EVIDENCE_KIND).sort()).toEqual([...CLAIM_TYPES].sort());
    expect(REQUIRED_EVIDENCE_KIND.EMPIRICAL).toBe('EXECUTION');
    expect(REQUIRED_EVIDENCE_KIND.DERIVED).toBe('DERIVATION');
    // A conjecture is honestly unbacked; requiring evidence would be a lie.
    expect(REQUIRED_EVIDENCE_KIND.CONJECTURE).toBeNull();
  });
});

describe('session status', () => {
  it('treats only finished states as terminal', () => {
    const terminal = SESSION_STATUSES.filter(isTerminalSessionStatus);
    expect(terminal).toEqual(['complete', 'failed', 'archived']);
  });

  it('keeps halted separate from paused, since only one is the user’s choice', () => {
    expect(SESSION_STATUSES).toContain('halted');
    expect(SESSION_STATUSES).toContain('paused');
    expect(isTerminalSessionStatus('halted')).toBe(false);
  });
});

import { z } from 'zod';
import { claimStatusSchema, claimTypeSchema, evidenceRefSchema } from './claim';
import {
  critiqueAxisSchema,
  disputeOutcomeSchema,
  disputeSeveritySchema,
  proposedTestSchema,
} from './dispute';
import {
  messageAuthorSchema,
  messageBodySchema,
  messageFinishReasonSchema,
  usageSchema,
} from './message';
import { modelRefSchema } from './model';
import {
  confidenceSchema,
  idSchema,
  proseSchema,
  sha256Schema,
  titleSchema,
  usdSchema,
} from './primitives';
import {
  gateDecisionSchema,
  gateKindSchema,
  gateOptionSchema,
  participantRoleSchema,
  phaseKindSchema,
  phaseOutcomeSchema,
  positionSchema,
  roleAssignmentSchema,
  roundModeSchema,
  roundOutcomeSchema,
} from './protocol';
import { sessionStatusSchema } from './session';

/**
 * Every kind of thing that can happen, as a payload schema per event type.
 *
 * The event log is the authoritative record; every table Sheep queries is
 * derived from it by replay (P5). Three conventions make that replay
 * trustworthy, and all three are load-bearing:
 *
 * - **Payloads carry no timestamps.** The log's `recordedAt` is the time an
 *   event happened. A payload that carried its own would let the two disagree.
 * - **Payloads are self-contained.** A session-scoped payload names its
 *   `sessionId` even though the log indexes one in its own column, so a
 *   projector never has to consult the envelope to know what it is looking at.
 * - **Payloads are strict.** An unknown key is a bug — a writer sending a field
 *   no reader understands — and is rejected at the boundary rather than silently
 *   persisted into a hash chain where it can never be corrected.
 *
 * Optional fields mean "not applicable", never "unknown"; projected rows use
 * `null` for the same idea, since a table column has to hold something.
 */

const sessionScope = { sessionId: idSchema };

export const EVENT_PAYLOADS = {
  /** App lifecycle. Not session-scoped, and never part of a research record. */
  'app.started': z.strictObject({
    version: z.string().min(1),
    platform: z.string().min(1),
    electron: z.string().min(1),
  }),

  'session.created': z.strictObject({
    ...sessionScope,
    title: titleSchema,
    question: proseSchema,
  }),
  'session.retitled': z.strictObject({ ...sessionScope, title: titleSchema }),
  'session.question-revised': z.strictObject({ ...sessionScope, question: proseSchema }),
  'session.status-changed': z.strictObject({
    ...sessionScope,
    status: sessionStatusSchema,
    reason: proseSchema.optional(),
  }),
  'session.budget-set': z.strictObject({ ...sessionScope, capUsd: usdSchema }),
  /** Spend as reported by the gateway, accumulated by the projection. */
  'session.spend-recorded': z.strictObject({
    ...sessionScope,
    costUsd: usdSchema,
    messageId: idSchema.optional(),
  }),

  'roster.model-attached': z.strictObject({
    ...sessionScope,
    participantId: idSchema,
    model: modelRefSchema,
    weight: z.number().min(0).max(10),
    budgetCapUsd: usdSchema.optional(),
    preferredRole: participantRoleSchema.optional(),
  }),
  /**
   * A participant's settings, restated in full.
   *
   * A full restatement rather than a patch, because the log's convention is
   * that an absent optional field means "not applicable" — so a payload that
   * used absence to mean "unchanged" would be unreadable to a projector
   * replaying it in isolation, which is the one thing a projector must not be.
   */
  'roster.model-reconfigured': z.strictObject({
    ...sessionScope,
    participantId: idSchema,
    weight: z.number().min(0).max(10),
    budgetCapUsd: usdSchema.optional(),
    preferredRole: participantRoleSchema.optional(),
  }),
  'roster.model-detached': z.strictObject({
    ...sessionScope,
    participantId: idSchema,
    reason: proseSchema.optional(),
  }),
  /** The solver's output for one round (Phase 24), recorded as a whole. */
  'roster.roles-assigned': z.strictObject({
    ...sessionScope,
    phaseId: idSchema,
    roundId: idSchema,
    assignments: z.array(roleAssignmentSchema).min(1),
  }),

  'phase.opened': z.strictObject({
    ...sessionScope,
    phaseId: idSchema,
    kind: phaseKindSchema,
    index: z.number().int().nonnegative(),
  }),
  'phase.closed': z.strictObject({
    ...sessionScope,
    phaseId: idSchema,
    outcome: phaseOutcomeSchema,
    summary: proseSchema.optional(),
  }),

  /**
   * The protocol has stopped and is waiting for a human (P3's companion: the
   * two places a person, not a model, decides what happens next).
   *
   * The proposal travels in the event rather than in a side table because it is
   * what was actually put to the user — a charter read off a row that could be
   * rewritten later would make the approval unauditable.
   */
  'phase.gate-raised': z.strictObject({
    ...sessionScope,
    phaseId: idSchema,
    gate: gateKindSchema,
    proposal: proseSchema,
    /** What there is to choose between, when the gate is a choice. */
    options: z.array(gateOptionSchema).optional(),
  }),
  'phase.gate-resolved': z.strictObject({
    ...sessionScope,
    phaseId: idSchema,
    gate: gateKindSchema,
    decision: gateDecisionSchema,
    /** `optionId`s the human picked. Absent when the gate offered no options. */
    selected: z.array(idSchema).optional(),
    note: proseSchema.optional(),
  }),

  'round.opened': z.strictObject({
    ...sessionScope,
    phaseId: idSchema,
    roundId: idSchema,
    index: z.number().int().nonnegative(),
    mode: roundModeSchema,
  }),
  'round.closed': z.strictObject({
    ...sessionScope,
    phaseId: idSchema,
    roundId: idSchema,
    outcome: roundOutcomeSchema,
  }),

  'message.recorded': z.strictObject({
    ...sessionScope,
    messageId: idSchema,
    phaseId: idSchema.optional(),
    roundId: idSchema.optional(),
    author: messageAuthorSchema,
    role: participantRoleSchema.optional(),
    body: messageBodySchema,
    usage: usageSchema.optional(),
    /**
     * How the turn stopped, when a model produced it.
     *
     * `cancelled` and `error` mean the body is what survived rather than what
     * the model finished — which is exactly why a partial response is recorded
     * rather than discarded: the tokens were paid for, and a run that vanished
     * without trace is not reproducible (P5).
     */
    finish: messageFinishReasonSchema.optional(),
    promptHash: sha256Schema.optional(),
  }),

  /**
   * A run the sandbox actually performed — what an `EMPIRICAL` claim must point
   * at (P2). The minimum the ledger checks against; Phase 41 widens the record.
   */
  'execution.recorded': z.strictObject({
    ...sessionScope,
    executionId: idSchema,
    codeHash: sha256Schema,
    exitCode: z.number().int(),
  }),
  /** A derivation, by content address — what a `DERIVED` claim must point at. */
  'derivation.recorded': z.strictObject({
    ...sessionScope,
    derivationId: idSchema,
    bodyHash: sha256Schema,
  }),

  'claim.recorded': z.strictObject({
    ...sessionScope,
    claimId: idSchema,
    claimType: claimTypeSchema,
    statement: z.string().min(1).max(2_000),
    phaseId: idSchema.optional(),
    /** The turn the claim was asserted in. */
    messageId: idSchema.optional(),
    authorParticipantId: idSchema.optional(),
    confidence: confidenceSchema.optional(),
    support: z.array(evidenceRefSchema).optional(),
  }),
  'claim.evidence-attached': z.strictObject({
    ...sessionScope,
    claimId: idSchema,
    evidence: evidenceRefSchema,
  }),
  'claim.status-changed': z.strictObject({
    ...sessionScope,
    claimId: idSchema,
    status: claimStatusSchema,
    reason: proseSchema.optional(),
  }),

  'dispute.opened': z.strictObject({
    ...sessionScope,
    disputeId: idSchema,
    claimId: idSchema,
    axis: critiqueAxisSchema,
    severity: disputeSeveritySchema,
    argument: proseSchema,
    raisedByParticipantId: idSchema.optional(),
    proposedTest: proposedTestSchema.optional(),
  }),
  'dispute.resolved': z.strictObject({
    ...sessionScope,
    disputeId: idSchema,
    outcome: disputeOutcomeSchema,
    rationale: proseSchema,
    evidence: z.array(evidenceRefSchema),
    resolvedByParticipantId: idSchema.optional(),
    /** Required when the outcome is `UNRESOLVED`: both sides ship (P6). */
    positions: z.array(positionSchema).optional(),
  }),
  'dispute.withdrawn': z.strictObject({
    ...sessionScope,
    disputeId: idSchema,
    reason: proseSchema.optional(),
  }),
} as const satisfies Record<string, z.ZodType>;

export type EventPayloads = typeof EVENT_PAYLOADS;

export type DomainEventType = keyof EventPayloads;

/** Payload type for one event type. */
export type EventPayload<T extends DomainEventType> = z.infer<EventPayloads[T]>;

/**
 * A `{ type, payload }` pair, as a discriminated union over `type`.
 *
 * Derived from `EVENT_PAYLOADS` rather than written out, so a new event type
 * cannot be added to the runtime map and forgotten in the types.
 */
export type DomainEvent = {
  [T in DomainEventType]: { readonly type: T; readonly payload: EventPayload<T> };
}[DomainEventType];

export const DOMAIN_EVENT_TYPES: readonly DomainEventType[] = Object.keys(
  EVENT_PAYLOADS,
).sort() as DomainEventType[];

const KNOWN_TYPES: ReadonlySet<string> = new Set<string>(DOMAIN_EVENT_TYPES);

export function isDomainEventType(type: string): type is DomainEventType {
  return KNOWN_TYPES.has(type);
}

export function payloadSchemaFor<T extends DomainEventType>(type: T): EventPayloads[T] {
  return EVENT_PAYLOADS[type];
}

/** Event types that belong to a session, i.e. everything but app lifecycle. */
export function isSessionScoped(type: DomainEventType): boolean {
  return type !== 'app.started';
}

export class UnknownEventTypeError extends Error {
  constructor(readonly type: string) {
    super(`Unknown domain event type: ${type}`);
    this.name = 'UnknownEventTypeError';
  }
}

export class EventPayloadError extends Error {
  constructor(
    readonly type: string,
    readonly issues: readonly string[],
  ) {
    super(`Invalid payload for ${type}: ${issues.join('; ')}`);
    this.name = 'EventPayloadError';
  }
}

export type ParseEventResult =
  | { readonly ok: true; readonly event: DomainEvent }
  | { readonly ok: false; readonly error: UnknownEventTypeError | EventPayloadError };

/**
 * Validates one log entry against the schema for its type.
 *
 * Returns a result rather than throwing, because a replay reading a log written
 * by a different build needs to *decide* what to do about an entry it cannot
 * understand — skipping it is often right, and crashing rarely is.
 */
export function safeParseDomainEvent(type: string, payload: unknown): ParseEventResult {
  if (!isDomainEventType(type)) {
    return { ok: false, error: new UnknownEventTypeError(type) };
  }

  const parsed = EVENT_PAYLOADS[type].safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: new EventPayloadError(type, describeIssues(parsed.error)) };
  }
  // The union is keyed by `type`, which TypeScript cannot narrow through an
  // indexed schema lookup; the parse above is what actually guarantees the pair.
  return { ok: true, event: { type, payload: parsed.data } as DomainEvent };
}

/** As `safeParseDomainEvent`, but throws. For writers, which control the input. */
export function parseDomainEvent(type: string, payload: unknown): DomainEvent {
  const result = safeParseDomainEvent(type, payload);
  if (!result.ok) throw result.error;
  return result.event;
}

/**
 * Type-safe constructor for an event about to be appended.
 *
 * Validates on the way in, so a malformed payload is refused before it can be
 * hashed into the chain, where it would be permanent.
 */
export function domainEvent<T extends DomainEventType>(
  type: T,
  payload: EventPayload<T>,
): { readonly type: T; readonly payload: EventPayload<T> } {
  const parsed = EVENT_PAYLOADS[type].safeParse(payload);
  if (!parsed.success) throw new EventPayloadError(type, describeIssues(parsed.error));
  return { type, payload: parsed.data as EventPayload<T> };
}

/** The `sessionId` a payload belongs to, or null for app-level events. */
export function sessionIdOf(event: DomainEvent): string | null {
  return 'sessionId' in event.payload ? event.payload.sessionId : null;
}

function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

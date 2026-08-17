import { z } from 'zod';
import { idSchema, proseSchema, timestampSchema, titleSchema, usdSchema } from './primitives';

/**
 * A session's lifecycle.
 *
 * `halted` is distinct from `paused`: paused is the user's decision, halted is
 * the budget governor's (Phase 17) — it stops mid-protocol and waits for an
 * explicit confirmation to spend more.
 */
export const SESSION_STATUSES = [
  'draft',
  'running',
  'paused',
  'halted',
  'complete',
  'failed',
  'archived',
] as const;
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/** Statuses from which no further work happens without a new decision. */
export const TERMINAL_SESSION_STATUSES = ['complete', 'failed', 'archived'] as const;

export function isTerminalSessionStatus(status: SessionStatus): boolean {
  return (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status);
}

export const sessionBudgetSchema = z.strictObject({
  /**
   * Hard ceiling. Reaching it halts the session rather than degrading it.
   *
   * Null means no cap has been set — deliberately not 0, which would otherwise
   * have to mean both "spend nothing" and "spend freely".
   */
  capUsd: usdSchema.nullable(),
  spentUsd: usdSchema,
});
export type SessionBudget = z.infer<typeof sessionBudgetSchema>;

/**
 * A research session: one question, one roster, one event stream.
 *
 * This is a *projected* shape — the authoritative record is the events in
 * `events.ts` that produce it. Nothing in the app should write a session row
 * except a projector replaying that log.
 */
export const sessionSchema = z.strictObject({
  sessionId: idSchema,
  title: titleSchema,
  /** The research question, as the user posed it before any model saw it. */
  question: proseSchema,
  status: sessionStatusSchema,
  budget: sessionBudgetSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Session = z.infer<typeof sessionSchema>;

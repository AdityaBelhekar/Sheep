import { z } from 'zod';

/**
 * The scalar vocabulary every domain schema is built from.
 *
 * Two rules hold throughout `@sheep/core`, and both exist so that a value
 * parsed out of the event log is byte-identical to the value that was written:
 *
 * 1. **No transforms.** No `.trim()`, `.default()`, `.catch()` or `.transform()`
 *    in anything that describes stored data. A schema that quietly rewrites its
 *    input would make the hash chain a hash of something other than what the
 *    caller believes it stored.
 * 2. **No clocks.** Payloads carry no timestamps of their own; the event log's
 *    `recordedAt` is the only time a domain event has. One truth, not two.
 */

/** Every domain identifier is a UUID string. */
export const idSchema = z.uuid();
export type Id = z.infer<typeof idSchema>;

/** ISO-8601 in UTC with milliseconds, e.g. `2026-08-17T09:12:33.041Z`. */
export const timestampSchema = z.iso.datetime();
export type Timestamp = z.infer<typeof timestampSchema>;

/** Lower-case SHA-256 hex digest — a content address, or a chain hash. */
export const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'expected a lower-case sha-256 hex digest');
export type Sha256 = z.infer<typeof sha256Schema>;

/** Text that must actually say something. */
export const textSchema = z.string().min(1);

/** A one-line human label. */
export const titleSchema = z.string().min(1).max(200);

/** Free-form prose: a research question, an argument, a rationale. */
export const proseSchema = z.string().min(1).max(20_000);

/** Short machine name: `anthropic`, `openai`, `ollama`. */
export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/, 'expected a lower-case slug');

/** Subjective probability in [0, 1]. Never used to auto-decide anything. */
export const confidenceSchema = z.number().min(0).max(1);

/** Money, in US dollars. Non-negative and finite; costs are never estimates of infinity. */
export const usdSchema = z.number().nonnegative().finite();

export const tokenCountSchema = z.number().int().nonnegative();

export const byteCountSchema = z.number().int().nonnegative();

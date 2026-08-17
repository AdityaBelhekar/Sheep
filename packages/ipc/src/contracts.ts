import { z } from 'zod';
import {
  credentialKindSchema,
  credentialRefSchema,
  idSchema,
  proseSchema,
  sessionSummarySchema,
  settingUpdateSchema,
  settingsSchema,
  titleSchema,
  vaultBackendSchema,
} from '@sheep/core';
import type { IpcChannel } from './channels';

/** A request/response pair of schemas for one channel. */
export interface IpcContract<Request = unknown, Response = unknown> {
  readonly request: z.ZodType<Request>;
  readonly response: z.ZodType<Response>;
}

const epochMillis = z.number().int().nonnegative();

/**
 * Every channel's wire contract. Both sides validate: main rejects a bad
 * request, the renderer rejects a bad reply. Nothing crosses the bridge
 * unvalidated.
 */
export const IPC_CONTRACTS = {
  'sheep:ping': {
    request: z.object({
      sentAt: epochMillis,
    }),
    response: z.object({
      pong: z.literal(true),
      app: z.string().min(1),
      version: z.string().min(1),
      receivedAt: epochMillis,
      elapsedMs: z.number().int(),
    }),
  },
  'sheep:event-log-summary': {
    request: z.object({}),
    response: z.object({
      count: z.number().int().nonnegative(),
      schemaVersion: z.number().int().nonnegative(),
      driver: z.string().min(1),
      journalMode: z.string().min(1),
      head: z
        .object({
          seq: z.number().int().positive(),
          entryHash: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .nullable(),
      chain: z.object({
        ok: z.boolean(),
        checked: z.number().int().nonnegative(),
        failures: z.array(
          z.object({
            seq: z.number().int().nonnegative(),
            reason: z.string().min(1),
            detail: z.string(),
          }),
        ),
      }),
    }),
  },
  'sheep:settings-read': {
    request: z.object({}),
    response: z.object({ settings: settingsSchema }),
  },
  'sheep:settings-write': {
    // Typed per key, so a theme update cannot carry a number.
    request: settingUpdateSchema,
    response: z.object({ settings: settingsSchema }),
  },
  /**
   * Which credentials exist and where they are kept — never what they are.
   * There is no channel that returns a secret, and no place in this contract a
   * secret could travel: the renderer's job is to say which credential to use,
   * and the main process resolves it.
   */
  'sheep:credential-summary': {
    request: z.object({}),
    response: z.object({
      backend: z.union([vaultBackendSchema, z.literal('none')]),
      description: z.string().min(1),
      credentials: z.array(
        z.object({
          credentialRef: credentialRefSchema,
          label: z.string().min(1),
          vendorId: z.string().min(1),
          kind: credentialKindSchema,
          lastVerifiedAt: z.string().nullable(),
        }),
      ),
    }),
  },
  /**
   * A read straight off the `sessions` projection.
   *
   * The renderer is given projected rows, never a query — it has no idea SQLite
   * exists, and could not reach it if it wanted to.
   */
  'sheep:sessions-list': {
    request: z.object({ limit: z.number().int().positive().max(500).optional() }),
    response: z.object({
      sessions: z.array(sessionSummarySchema),
      /** How far the projection has replayed, for the status bar. */
      projectedThroughSeq: z.number().int().nonnegative(),
    }),
  },
  'sheep:session-create': {
    request: z.object({ title: titleSchema, question: proseSchema }),
    response: z.object({
      sessionId: idSchema,
      sessions: z.array(sessionSummarySchema),
      projectedThroughSeq: z.number().int().nonnegative(),
    }),
  },
} as const satisfies Record<IpcChannel, IpcContract>;

export type IpcContracts = typeof IPC_CONTRACTS;

export type IpcRequest<C extends IpcChannel> = z.infer<IpcContracts[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.infer<IpcContracts[C]['response']>;

export function contractFor<C extends IpcChannel>(channel: C): IpcContracts[C] {
  return IPC_CONTRACTS[channel];
}

/** Flattens zod issues into stable `path: message` strings for error text. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

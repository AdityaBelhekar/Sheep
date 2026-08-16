import { z } from 'zod';
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

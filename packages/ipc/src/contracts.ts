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

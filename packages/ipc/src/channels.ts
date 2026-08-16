/**
 * The IPC channel allowlist.
 *
 * This module is the single source of truth for which channels exist, and is
 * imported by the preload script — so it must not pull in zod or anything else.
 * The contracts in `contracts.ts` are keyed off this list, and a test asserts
 * the two never drift apart.
 */
import { UnknownChannelError } from './errors';

export const IPC_CHANNELS = ['sheep:ping', 'sheep:event-log-summary'] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

const KNOWN: ReadonlySet<string> = new Set<string>(IPC_CHANNELS);

export function isKnownChannel(channel: string): channel is IpcChannel {
  return KNOWN.has(channel);
}

/** Throws `UnknownChannelError` for anything not on the allowlist. */
export function assertKnownChannel(channel: string): asserts channel is IpcChannel {
  if (!isKnownChannel(channel)) throw new UnknownChannelError(channel);
}

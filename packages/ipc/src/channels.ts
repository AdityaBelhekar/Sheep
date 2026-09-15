/**
 * The IPC channel allowlist.
 *
 * This module is the single source of truth for which channels exist, and is
 * imported by the preload script — so it must not pull in zod or anything else.
 * The contracts in `contracts.ts` are keyed off this list, and a test asserts
 * the two never drift apart.
 */
import { UnknownChannelError } from './errors';

export const IPC_CHANNELS = [
  'sheep:ping',
  'sheep:event-log-summary',
  'sheep:settings-read',
  'sheep:settings-write',
  'sheep:credential-summary',
  'sheep:sessions-list',
  'sheep:session-create',
  'sheep:session-get',
  'sheep:session-budget-set',
  'sheep:roster-attach',
  'sheep:roster-reconfigure',
  'sheep:roster-detach',
  'sheep:models-list',
  'sheep:messages-list',
  'sheep:protocol-state',
  'sheep:protocol-run',
  'sheep:protocol-approve',
  'sheep:protocol-cancel',
  'sheep:ledger-get',
  'sheep:claim-record',
  'sheep:claim-provenance',
  'sheep:chat-send',
  'sheep:chat-cancel',
  'sheep:connections-list',
  'sheep:connection-create',
  'sheep:connection-update',
  'sheep:connection-delete',
  'sheep:connection-test',
  'sheep:connection-sign-in',
  'sheep:local-providers-detect',
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/**
 * One-way channels, main → renderer.
 *
 * Kept apart from the request/response list rather than merged into it: the two
 * have opposite directions and opposite trust, and a single allowlist would let
 * a renderer `invoke` a channel that only main is supposed to speak on.
 */
export const IPC_EVENT_CHANNELS = ['sheep:stream-event', 'sheep:protocol-event'] as const;

export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number];

const KNOWN: ReadonlySet<string> = new Set<string>(IPC_CHANNELS);
const KNOWN_EVENTS: ReadonlySet<string> = new Set<string>(IPC_EVENT_CHANNELS);

export function isKnownChannel(channel: string): channel is IpcChannel {
  return KNOWN.has(channel);
}

export function isKnownEventChannel(channel: string): channel is IpcEventChannel {
  return KNOWN_EVENTS.has(channel);
}

/** Throws `UnknownChannelError` for anything not on the allowlist. */
export function assertKnownChannel(channel: string): asserts channel is IpcChannel {
  if (!isKnownChannel(channel)) throw new UnknownChannelError(channel);
}

export function assertKnownEventChannel(channel: string): asserts channel is IpcEventChannel {
  if (!isKnownEventChannel(channel)) throw new UnknownChannelError(channel);
}

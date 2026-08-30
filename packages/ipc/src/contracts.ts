import { z } from 'zod';
import {
  connectionConfigSchema,
  connectionSchema,
  credentialKindSchema,
  credentialRefSchema,
  idSchema,
  localProviderIdSchema,
  messageSchema,
  modelIdSchema,
  participantRoleSchema,
  proseSchema,
  rosterEntrySchema,
  sessionSummarySchema,
  settingUpdateSchema,
  settingsSchema,
  titleSchema,
  usdSchema,
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
 * A secret on its way to the vault.
 *
 * Bounded rather than free-form so a paste accident cannot push a megabyte of
 * something else into the OS credential store, and never `.trim()`ed here — the
 * main process decides what to do with surrounding whitespace, and a schema
 * that silently rewrote the value would store something other than what was
 * typed.
 */
const secretSchema = z.string().min(1).max(8_192);

/**
 * A session and its roster, returned by every roster write as well as the read.
 *
 * One shape for all of them so the renderer never has to merge a partial reply
 * into its own copy — what it draws is always what main just read back out of
 * the projection, not a local guess about what a write did.
 */
const sessionDetailReply = z.object({
  session: sessionSummarySchema,
  roster: z.array(rosterEntrySchema),
  projectedThroughSeq: z.number().int().nonnegative(),
});

/** The connection list, on the same principle, for every connection channel. */
const connectionsReply = z.object({
  connections: z.array(connectionSchema),
  /** Where secrets go on this machine, or `none` if nowhere safe does. */
  vaultBackend: z.union([vaultBackendSchema, z.literal('none')]),
  vaultDescription: z.string().min(1),
});

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

  /**
   * One session with its roster.
   *
   * The roster comes back with the session rather than on a channel of its own,
   * because a roster without the session it belongs to is not a thing anything
   * wants — and two calls would let the renderer render one against the other.
   */
  'sheep:session-get': {
    request: z.object({ sessionId: idSchema }),
    response: sessionDetailReply,
  },
  'sheep:session-budget-set': {
    request: z.object({ sessionId: idSchema, capUsd: usdSchema }),
    response: sessionDetailReply,
  },
  'sheep:roster-attach': {
    request: z.object({
      sessionId: idSchema,
      /** The connection to reach this model through, and the model on it. */
      connectionId: idSchema,
      modelId: modelIdSchema,
      weight: z.number().min(0).max(10),
      budgetCapUsd: usdSchema.nullable(),
      preferredRole: participantRoleSchema.nullable(),
    }),
    response: sessionDetailReply.extend({ participantId: idSchema }),
  },
  /** The participant's settings, restated in full — never a patch. */
  'sheep:roster-reconfigure': {
    request: z.object({
      sessionId: idSchema,
      participantId: idSchema,
      weight: z.number().min(0).max(10),
      budgetCapUsd: usdSchema.nullable(),
      preferredRole: participantRoleSchema.nullable(),
    }),
    response: sessionDetailReply,
  },
  'sheep:roster-detach': {
    request: z.object({
      sessionId: idSchema,
      participantId: idSchema,
      reason: proseSchema.optional(),
    }),
    response: sessionDetailReply,
  },
  /**
   * The catalogue across every enabled connection.
   *
   * `failures` is part of the answer rather than an error: one unreachable
   * provider must not make the roster unusable, and a list that silently
   * omitted its models would be lying about what is available.
   */
  'sheep:models-list': {
    request: z.object({ refresh: z.boolean().optional() }),
    response: z.object({
      models: z.array(
        z.object({
          connectionId: idSchema,
          connectionLabel: titleSchema,
          adapterId: z.string().min(1),
          vendorId: z.string().min(1),
          modelId: modelIdSchema,
          displayName: z.string().min(1),
          contextWindowTokens: z.number().int().nonnegative(),
          maxOutputTokens: z.number().int().nonnegative(),
          local: z.boolean(),
          /** Null means the cost cannot be predicted, which is not the same as free. */
          inputPerMTokUsd: usdSchema.nullable(),
          outputPerMTokUsd: usdSchema.nullable(),
        }),
      ),
      failures: z.array(z.object({ adapterId: z.string().min(1), detail: z.string() })),
    }),
  },

  /** The session's turns, in log order — the only total order two share. */
  'sheep:messages-list': {
    request: z.object({
      sessionId: idSchema,
      limit: z.number().int().positive().max(1_000).optional(),
    }),
    response: z.object({ messages: z.array(messageSchema) }),
  },
  /**
   * Start one turn.
   *
   * Returns as soon as the run is accepted, not when it finishes: the answer
   * arrives on `sheep:stream-event`, keyed by the `runId` returned here. The
   * user's message is already recorded by the time this replies, so a crash
   * mid-stream loses the answer and never the question.
   */
  'sheep:chat-send': {
    request: z.object({
      sessionId: idSchema,
      participantId: idSchema,
      text: z.string().min(1).max(32_768),
    }),
    response: z.object({
      runId: idSchema,
      userMessageId: idSchema,
      /** The id the answer will be recorded under, known before it exists. */
      assistantMessageId: idSchema,
      /** What the call is expected to cost, priced at the worst case. */
      estimatedCostUsd: usdSchema.nullable(),
    }),
  },
  'sheep:chat-cancel': {
    request: z.object({ runId: idSchema }),
    /** False when the run had already finished — not an error, just late. */
    response: z.object({ cancelled: z.boolean() }),
  },

  /**
   * Connections.
   *
   * A secret travels renderer → main on create and update, and only there.
   * That direction is unavoidable — a key has to be typed somewhere — but it is
   * one-way: no response on any channel carries a secret back, and the reply to
   * a write is the same redacted record the list returns.
   */
  'sheep:connections-list': {
    request: z.object({}),
    response: connectionsReply,
  },
  'sheep:connection-create': {
    request: z.object({
      label: titleSchema,
      config: connectionConfigSchema,
      /** Omitted for a local runtime, and for a connection that signs in. */
      secret: secretSchema.optional(),
      enabled: z.boolean().optional(),
    }),
    response: connectionsReply.extend({ connectionId: idSchema }),
  },
  'sheep:connection-update': {
    request: z.object({
      connectionId: idSchema,
      label: titleSchema.optional(),
      config: connectionConfigSchema.optional(),
      /** Present only when the secret is being replaced; absent keeps it. */
      secret: secretSchema.optional(),
      enabled: z.boolean().optional(),
    }),
    response: connectionsReply,
  },
  'sheep:connection-delete': {
    request: z.object({ connectionId: idSchema }),
    response: connectionsReply.extend({ removed: z.boolean() }),
  },
  'sheep:connection-test': {
    request: z.object({ connectionId: idSchema }),
    response: connectionsReply.extend({ connection: connectionSchema }),
  },
  /** Runs the loopback PKCE flow in main and stores the refresh token. */
  'sheep:connection-sign-in': {
    request: z.object({ connectionId: idSchema }),
    response: connectionsReply.extend({ connection: connectionSchema }),
  },
  'sheep:local-providers-detect': {
    request: z.object({}),
    response: z.object({
      providers: z.array(
        z.object({
          id: localProviderIdSchema,
          displayName: z.string().min(1),
          baseUrl: z.string().min(1),
          status: z.enum(['running', 'absent', 'unreachable']),
          models: z.array(z.string()),
          install: z.string().min(1),
          detail: z.string().optional(),
        }),
      ),
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

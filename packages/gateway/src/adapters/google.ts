import type { AdapterId, ListModelsOptions, ModelAdapter, StreamOptions } from '../adapter';
import { OAuthClient, type OAuthClientOptions, type TokenStore } from '../auth/oauth';
import { accessTokenProvider } from '../auth/oauth';
import { resolveSecret, type SecretProvider } from '../credentials';
import type { Delta, StopReason, TokenUsage } from '../delta';
import {
  capabilities,
  type CapabilityFlags,
  type ModelDescriptor,
  type ModelPricing,
} from '../descriptor';
import { CredentialError } from '../errors';
import { HttpClient, type FetchLike } from '../http/client';
import type { NormalizedMessage, NormalizedRequest, ToolSpec } from '../request';

/**
 * Gemini, reached either with a pasted API key or with a real Google sign-in.
 *
 * Both land on the same class and differ by one header, which is the point: a
 * signed-in connection must not be a second code path, or half the gateway's
 * behaviour would only be exercised by whichever kind the developer happened to
 * use. `credentials` decides the header; everything after it is identical.
 */

export const GOOGLE_VENDOR_ID = 'google';
export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export const GOOGLE_OAUTH_ENDPOINTS = {
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revocationUrl: 'https://oauth2.googleapis.com/revoke',
} as const;

/**
 * `access_type=offline` is what makes Google issue a refresh token at all, and
 * `prompt=consent` is what makes it issue one *again* on a repeat sign-in —
 * without it a user who signs in twice gets an access token that expires in an
 * hour and no way to renew it.
 */
export const GOOGLE_AUTHORIZATION_PARAMS: Record<string, string> = {
  access_type: 'offline',
  include_granted_scopes: 'true',
};

/** Broad enough to call a Gemini model on the caller's own Cloud project. */
export const GOOGLE_DEFAULT_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

export const GEMINI_DEFAULT_CAPABILITIES: CapabilityFlags = capabilities({
  streaming: true,
  systemPrompt: true,
  tools: true,
  parallelToolCalls: true,
  vision: true,
  reasoning: true,
  jsonSchemaOutput: true,
  promptCaching: true,
  stopSequences: true,
  temperature: true,
  topP: true,
  seed: true,
});

/** An API key in a header, or a bearer token from a Google sign-in. */
export type GoogleCredentials =
  | { readonly kind: 'apiKey'; readonly apiKey: SecretProvider }
  | { readonly kind: 'oauth'; readonly accessToken: () => Promise<string> };

export interface GoogleAdapterOptions {
  readonly adapterId?: AdapterId;
  readonly credentials: GoogleCredentials;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly models?: readonly ModelDescriptor[];
  /** Prices per model id; Google's catalogue endpoint publishes none. */
  readonly modelPricing?: Readonly<Record<string, ModelPricing>>;
  readonly timeoutMs?: number;
}

/**
 * The Phase 14 outcome, in one call: sign in, keep the refresh token, hand back
 * an adapter that never sees a pasted key.
 */
export function createGoogleOAuthAdapter(options: {
  readonly adapterId?: AdapterId;
  readonly client: OAuthClient;
  readonly store: TokenStore;
  readonly fetch?: FetchLike;
  readonly modelPricing?: Readonly<Record<string, ModelPricing>>;
}): GoogleAdapter {
  return new GoogleAdapter({
    ...(options.adapterId ? { adapterId: options.adapterId } : {}),
    credentials: { kind: 'oauth', accessToken: accessTokenProvider(options.client, options.store) },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.modelPricing ? { modelPricing: options.modelPricing } : {}),
  });
}

/** A Google OAuth client with the endpoints and offline-access parameters set. */
export function createGoogleOAuthClient(
  options: Omit<OAuthClientOptions, 'endpoints' | 'scopes' | 'authorizationParams'> & {
    readonly scopes?: readonly string[];
  },
): OAuthClient {
  return new OAuthClient({
    ...options,
    endpoints: GOOGLE_OAUTH_ENDPOINTS,
    scopes: options.scopes ?? GOOGLE_DEFAULT_SCOPES,
    authorizationParams: GOOGLE_AUTHORIZATION_PARAMS,
  });
}

export class GoogleAdapter implements ModelAdapter {
  readonly adapterId: AdapterId;
  readonly vendorId = GOOGLE_VENDOR_ID;
  readonly #options: GoogleAdapterOptions;
  readonly #http: HttpClient;
  #discovered: ModelDescriptor[] | undefined;

  constructor(options: GoogleAdapterOptions) {
    this.adapterId = options.adapterId ?? GOOGLE_VENDOR_ID;
    this.#options = options;
    this.#http = new HttpClient({
      adapterId: this.adapterId,
      baseUrl: options.baseUrl ?? GOOGLE_BASE_URL,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      headers: async (): Promise<Record<string, string>> => {
        const credentials = options.credentials;
        if (credentials.kind === 'apiKey') {
          // The header, never the query string: a key in a URL ends up in
          // proxy logs and browser history.
          return { 'x-goog-api-key': await resolveSecret(this.adapterId, credentials.apiKey) };
        }
        const token = await credentials.accessToken();
        if (!token) throw new CredentialError(this.adapterId, 'the sign-in produced no token');
        return { authorization: `Bearer ${token}` };
      },
    });
  }

  /** Whether this connection is a pasted key or a signed-in account. */
  get authKind(): GoogleCredentials['kind'] {
    return this.#options.credentials.kind;
  }

  async listModels(options: ListModelsOptions = {}): Promise<ModelDescriptor[]> {
    if (this.#options.models) return [...this.#options.models];
    if (!options.refresh && this.#discovered) return [...this.#discovered];

    const response = await this.#http.json<{ models?: GoogleModelRow[] }>({
      method: 'GET',
      path: '/models',
      query: { pageSize: '200' },
      ...(options.signal ? { signal: options.signal } : {}),
    });

    this.#discovered = (response.models ?? [])
      // Embedding models answer here too, and cannot hold a conversation.
      .filter((row) => (row.supportedGenerationMethods ?? []).some(isGenerative))
      .map((row) => this.#toDescriptor(row));
    return [...this.#discovered];
  }

  async describeModel(
    modelId: string,
    options: ListModelsOptions = {},
  ): Promise<ModelDescriptor | null> {
    const all = await this.listModels(options);
    return all.find((entry) => entry.modelId === modelId) ?? null;
  }

  async *stream(
    request: NormalizedRequest,
    options: StreamOptions = {},
  ): AsyncGenerator<Delta, void, undefined> {
    const events = this.#http.sse({
      method: 'POST',
      path: `/models/${request.modelId}:streamGenerateContent`,
      query: { alt: 'sse' },
      body: this.toWire(request),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    let started = false;
    let stopReason: StopReason = 'stop';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    /** Gemini has no call ids; one is synthesised and kept stable per call. */
    let callIndex = 0;

    for await (const event of events) {
      if (event.data.length === 0) continue;
      const chunk = JSON.parse(event.data) as GoogleChunk;

      if (!started) {
        started = true;
        yield {
          kind: 'start',
          model: {
            vendorId: GOOGLE_VENDOR_ID,
            modelId: request.modelId,
            ...(chunk.modelVersion ? { version: chunk.modelVersion } : {}),
          },
          ...(chunk.responseId ? { providerRequestId: chunk.responseId } : {}),
        };
      }

      if (chunk.usageMetadata) usage = mergeUsage(usage, chunk.usageMetadata);

      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;

      for (const part of candidate.content?.parts ?? []) {
        if (part.functionCall) {
          const callId = part.functionCall.id ?? `${part.functionCall.name}_${String(callIndex)}`;
          callIndex += 1;
          yield { kind: 'tool_call_start', callId, name: part.functionCall.name };
          yield {
            kind: 'tool_call_delta',
            callId,
            // Arguments arrive whole here, not as fragments — one delta is the
            // honest representation of that.
            argumentsJson: JSON.stringify(part.functionCall.args ?? {}),
          };
          yield { kind: 'tool_call_end', callId };
        } else if (typeof part.text === 'string' && part.text.length > 0) {
          yield part.thought
            ? { kind: 'reasoning', text: part.text }
            : { kind: 'text', text: part.text };
        }
      }

      if (candidate.finishReason) stopReason = mapFinishReason(candidate.finishReason);
    }

    if (started) yield { kind: 'end', stopReason, usage };
  }

  async countInputTokens(request: NormalizedRequest, options: StreamOptions = {}): Promise<number> {
    const wire = this.toWire(request);
    const response = await this.#http.json<{ totalTokens: number }>({
      method: 'POST',
      path: `/models/${request.modelId}:countTokens`,
      body: {
        contents: wire['contents'],
        ...(wire['systemInstruction'] ? { systemInstruction: wire['systemInstruction'] } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return response.totalTokens;
  }

  /** The normalized request in Gemini's shape. Public for the recorder. */
  toWire(request: NormalizedRequest): Record<string, unknown> {
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: request.maxOutputTokens,
    };
    if (request.temperature !== undefined) generationConfig['temperature'] = request.temperature;
    if (request.topP !== undefined) generationConfig['topP'] = request.topP;
    if (request.seed !== undefined) generationConfig['seed'] = request.seed;
    if (request.stopSequences?.length) {
      generationConfig['stopSequences'] = [...request.stopSequences];
    }
    if (request.responseFormat?.kind === 'json_schema') {
      generationConfig['responseMimeType'] = 'application/json';
      generationConfig['responseSchema'] = request.responseFormat.schema;
    }

    const body: Record<string, unknown> = {
      contents: request.messages.map(toWireContent),
      generationConfig,
    };

    if (request.system !== null) {
      body['systemInstruction'] = { parts: [{ text: request.system }] };
    }
    if (request.tools?.length) {
      body['tools'] = [{ functionDeclarations: request.tools.map(toWireTool) }];
    }
    if (request.toolChoice) body['toolConfig'] = toWireToolConfig(request.toolChoice);

    return body;
  }

  #toDescriptor(row: GoogleModelRow): ModelDescriptor {
    // `models/gemini-2.5-pro` is how the catalogue names it; the request path
    // wants the same form, so the prefix is kept rather than stripped.
    const modelId = row.name;
    return {
      vendorId: GOOGLE_VENDOR_ID,
      modelId: modelId.replace(/^models\//, ''),
      displayName: row.displayName ?? modelId,
      contextWindowTokens: row.inputTokenLimit ?? 1_000_000,
      maxOutputTokens: row.outputTokenLimit ?? 8_192,
      capabilities: GEMINI_DEFAULT_CAPABILITIES,
      pricing: this.#options.modelPricing?.[modelId.replace(/^models\//, '')] ?? null,
      local: false,
    };
  }
}

function isGenerative(method: string): boolean {
  return method === 'generateContent' || method === 'streamGenerateContent';
}

function toWireContent(message: NormalizedMessage): Record<string, unknown> {
  return {
    // Gemini calls the assistant `model`.
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: message.content.map((part) => {
      switch (part.kind) {
        case 'text':
          return { text: part.text };
        case 'image':
          return { inlineData: { mimeType: part.mediaType, data: part.dataBase64 } };
        case 'tool_use':
          return { functionCall: { name: part.name, args: parseArguments(part.argumentsJson) } };
        case 'tool_result':
          return {
            // Keyed by tool name, not call id: this API has no call ids, so a
            // parallel-call turn is matched by name and order.
            functionResponse: {
              name: part.callId,
              response: { content: part.content, ...(part.isError ? { error: true } : {}) },
            },
          };
      }
    }),
  };
}

function toWireTool(tool: ToolSpec): Record<string, unknown> {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

function toWireToolConfig(choice: NonNullable<NormalizedRequest['toolChoice']>): unknown {
  if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } };
}

function parseArguments(argumentsJson: string): unknown {
  if (argumentsJson.trim().length === 0) return {};
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return {};
  }
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'STOP_SEQUENCE':
      return 'stop_sequence';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function mergeUsage(usage: TokenUsage, reported: GoogleUsage): TokenUsage {
  const cached = reported.cachedContentTokenCount;
  const prompt = reported.promptTokenCount ?? usage.inputTokens;
  return {
    // Like OpenAI, Google counts cached tokens inside the prompt total.
    inputTokens: cached ? Math.max(0, prompt - cached) : prompt,
    outputTokens: reported.candidatesTokenCount ?? usage.outputTokens,
    ...(cached ? { cachedInputTokens: cached } : {}),
    ...(reported.thoughtsTokenCount ? { reasoningTokens: reported.thoughtsTokenCount } : {}),
  };
}

interface GoogleUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

interface GoogleChunk {
  modelVersion?: string;
  responseId?: string;
  usageMetadata?: GoogleUsage;
  candidates?: {
    content?: {
      parts?: {
        text?: string;
        thought?: boolean;
        functionCall?: { id?: string; name: string; args?: unknown };
      }[];
    };
    finishReason?: string;
  }[];
}

interface GoogleModelRow {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

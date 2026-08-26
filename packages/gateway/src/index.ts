/**
 * @sheep/gateway — Model adapters, cost accounting and provider resilience.
 *
 * One shape in (`NormalizedRequest`), one shape out (`Delta`), one place that
 * decides whether a call may happen (`AdapterRegistry`). Everything a vendor
 * does differently stops at its adapter; nothing above this package knows which
 * company answered except by reading `vendorId` — which is exactly what P1
 * needs to hold a critique to a different set of weights than the claim.
 *
 * The mock adapter lives at `@sheep/gateway/mock`, off the main barrel.
 */
export const PACKAGE_NAME = '@sheep/gateway';

export {
  adapterIdSchema,
  type AdapterId,
  type ListModelsOptions,
  type ModelAdapter,
  type StreamOptions,
} from './adapter';

export {
  capabilities,
  capabilityFlagsSchema,
  FREE_PRICING,
  MODEL_CAPABILITIES,
  modelCapabilitySchema,
  modelDescriptorSchema,
  modelPricingSchema,
  supportedCapabilities,
  type CapabilityFlags,
  type ModelCapability,
  type ModelDescriptor,
  type ModelPricing,
} from './descriptor';

export {
  contentPartSchema,
  imagePartSchema,
  missingCapabilities,
  normalizedMessageSchema,
  normalizedRequestSchema,
  requestMetadataSchema,
  requiredCapabilities,
  responseFormatSchema,
  textPartSchema,
  toolChoiceSchema,
  toolResultPartSchema,
  toolSpecSchema,
  toolUsePartSchema,
  type ContentPart,
  type NormalizedMessage,
  type NormalizedRequest,
  type RequestMetadata,
  type ResponseFormat,
  type ToolChoice,
  type ToolSpec,
} from './request';

export {
  collectDeltas,
  deltaSchema,
  respondingModelSchema,
  STOP_REASONS,
  stopReasonSchema,
  tokenUsageSchema,
  type CollectedResponse,
  type CompletedToolCall,
  type Delta,
  type DeltaKind,
  type RespondingModel,
  type StopReason,
  type TokenUsage,
} from './delta';

export {
  addCosts,
  COST_BASES,
  costBasisSchema,
  costEstimateSchema,
  priceUsage,
  priceUsageFor,
  roundUsd,
  TOKENS_PER_PRICING_UNIT,
  toUsage,
  type CostBasis,
  type CostEstimate,
} from './cost';

export { AdapterRegistry, type AdapterRegistryOptions, type ModelHandle } from './registry';

export { resolveSecret, type SecretProvider } from './credentials';

export {
  computeBackoffMs,
  DEFAULT_BACKOFF,
  isRetryable,
  retryDelayMs,
  sleep,
  type BackoffOptions,
  type Sleep,
} from './resilience/backoff';

export { TokenBucket, type TokenBucketOptions } from './resilience/token-bucket';

export {
  CIRCUIT_STATES,
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
} from './resilience/circuit-breaker';

export {
  canonicalJson,
  ExchangeRecorder,
  hashOf,
  memoryBlobStore,
  replayDeltas,
  replayTranscript,
  type BlobPut,
  type ExchangeRecord,
  type RecordedRequest,
} from './resilience/recorder';

export {
  ResilientAdapter,
  withResilience,
  type ResilienceOptions,
  type RetryOptions,
} from './resilience/resilient-adapter';

export {
  HttpClient,
  type FetchLike,
  type HeaderProvider,
  type HttpClientOptions,
  type HttpRequest,
} from './http/client';

export { toJsonLines, toLines, toSseEvents, type SseEvent } from './http/sse';

export {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_MODELS,
  ANTHROPIC_VENDOR_ID,
  AnthropicAdapter,
  type AnthropicAdapterOptions,
} from './adapters/anthropic';

export {
  createLlamaCppAdapter,
  createLmStudioAdapter,
  createLocalAdapter,
  detectLocalProviders,
  LLAMA_CPP_BASE_URL,
  LM_STUDIO_BASE_URL,
  LOCAL_CAPABILITIES,
  LOCAL_HOST,
  LOCAL_PROVIDERS,
  OLLAMA_BASE_URL,
  OllamaAdapter,
  probeLocalProvider,
  type DetectOptions,
  type LocalProviderId,
  type LocalProviderStatus,
  type OllamaAdapterOptions,
} from './adapters/local';

export {
  createGoogleOAuthAdapter,
  createGoogleOAuthClient,
  GEMINI_DEFAULT_CAPABILITIES,
  GOOGLE_AUTHORIZATION_PARAMS,
  GOOGLE_BASE_URL,
  GOOGLE_DEFAULT_SCOPES,
  GOOGLE_OAUTH_ENDPOINTS,
  GOOGLE_VENDOR_ID,
  GoogleAdapter,
  type GoogleAdapterOptions,
  type GoogleCredentials,
} from './adapters/google';

export {
  accessTokenProvider,
  memoryTokenStore,
  OAuthClient,
  type OAuthClientOptions,
  type OAuthEndpoints,
  type SignInOptions,
  type TokenSet,
  type TokenStore,
} from './auth/oauth';

export { challengeFor, createPkcePair, createState, type PkcePair } from './auth/pkce';

export {
  startLoopbackServer,
  type LoopbackOptions,
  type LoopbackResult,
  type LoopbackServer,
} from './auth/loopback';

export {
  createAzureOpenAiAdapter,
  createOpenAiAdapter,
  OPENAI_BASE_URL,
  OPENAI_COMPATIBLE_PRESETS,
  OPENAI_DEFAULT_CAPABILITIES,
  OPENAI_VENDOR_ID,
  OpenAiCompatibleAdapter,
  type OpenAiCompatibleOptions,
  type OpenAiCompatiblePreset,
  type OpenAiPresetName,
} from './adapters/openai';

export {
  BudgetExceededError,
  CircuitOpenError,
  CredentialError,
  DuplicateAdapterError,
  GATEWAY_ERROR_CODES,
  GatewayError,
  InvalidDeltaError,
  InvalidRequestError,
  isRetryableStatus,
  PricingUnknownError,
  ProviderError,
  RateLimitedError,
  StreamCancelledError,
  StreamProtocolError,
  UnknownAdapterError,
  UnknownModelError,
  TransportError,
  UnsupportedCapabilityError,
  type GatewayErrorCode,
} from './errors';

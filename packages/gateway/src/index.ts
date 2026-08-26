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

export {
  DuplicateAdapterError,
  GATEWAY_ERROR_CODES,
  GatewayError,
  InvalidDeltaError,
  InvalidRequestError,
  PricingUnknownError,
  StreamCancelledError,
  StreamProtocolError,
  UnknownAdapterError,
  UnknownModelError,
  UnsupportedCapabilityError,
  type GatewayErrorCode,
} from './errors';

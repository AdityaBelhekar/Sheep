/**
 * @sheep/orchestrator — the protocol.
 *
 * A session is not a conversation with several models in it; it is a sequence
 * of phases with rules about who may speak, in what order, and about whose
 * work. This package is those rules, and it is deliberately free of I/O: the
 * state machine folds events, the solver is a pure function, and everything
 * that touches a database or a provider arrives through `OrchestratorPorts`.
 *
 * That is what lets the same engine run against real models in a utility
 * process and against a fixture file in a test at zero cost.
 */
export const PACKAGE_NAME = '@sheep/orchestrator';

export {
  DEFAULT_RPC_TIMEOUT_MS,
  RpcClosedError,
  RpcPeer,
  RpcTimeoutError,
  pairedTransports,
  type RpcHandler,
  type RpcPeerOptions,
  type RpcTransport,
} from './rpc';

export {
  PHASE_SEQUENCE,
  ProtocolError,
  applyProtocolEvent,
  assertCanClosePhase,
  assertCanCloseRound,
  assertCanOpenPhase,
  assertCanOpenRound,
  assertCanResolveGate,
  initialProtocolState,
  isProtocolEvent,
  nextPhaseKind,
  openPhase,
  pendingGate,
  phaseById,
  reduceProtocol,
  type GateState,
  type PhaseState,
  type ProtocolState,
  type RoleTally,
  type RoundState,
} from './state';

export {
  UnsatisfiableRolesError,
  solveRoles,
  violations,
  type RoleDemand,
  type SolveRolesInput,
  type SolveRolesResult,
  type SolverParticipant,
} from './roles';

export {
  DEFAULT_BLIND_CONCURRENCY,
  BlindRevealError,
  BlindRoundResult,
  runBlindParallel,
  type BlindRoundOptions,
  type BlindTurnResult,
} from './blind';

export {
  clusterTexts,
  cosineOfBags,
  cosineSimilarity,
  maxPairwiseSimilarity,
  meanPairwiseSimilarity,
  tokenise,
  type Cluster,
  type ClusterItem,
} from './similarity';

export {
  DEFAULT_TERMINATION_RULES,
  TERMINATION_REASONS,
  shouldTerminate,
  type TerminationInput,
  type TerminationReason,
  type TerminationRules,
  type TerminationVerdict,
} from './termination';

export {
  BASE_SYSTEM,
  HYPOTHESES_PER_MODEL,
  ModelOutputError,
  charterPrompt,
  extractJsonObject,
  framingStatementPrompt,
  hypothesisListSchema,
  hypothesisPrompt,
  hypothesisScoresSchema,
  hypothesisScoringPrompt,
  parseJsonReply,
  systemFor,
} from './prompts';

export type {
  OrchestratorPorts,
  ProgressKind,
  ProgressUpdate,
  SessionSnapshot,
  TurnRequest,
  TurnResponse,
} from './ports';

export {
  Orchestrator,
  hashRequest,
  toProtocolView,
  turnsOf,
  type ApproveInput,
  type OrchestratorOptions,
  type ProtocolGateView,
  type ProtocolPhaseView,
  type ProtocolRoundView,
  type ProtocolView,
  type RecordedTurn,
  type RunOutcome,
  type RunStatus,
} from './engine';

/**
 * @sheep/ipc — typed, zod-validated IPC channel contracts shared by main,
 * preload and renderer.
 */
export const PACKAGE_NAME = '@sheep/ipc';

export { IPC_CHANNELS, assertKnownChannel, isKnownChannel, type IpcChannel } from './channels';
export {
  IPC_CONTRACTS,
  contractFor,
  describeIssues,
  type IpcContract,
  type IpcContracts,
  type IpcRequest,
  type IpcResponse,
} from './contracts';
export {
  DuplicateHandlerError,
  IPC_ERROR_CODES,
  IpcError,
  IpcValidationError,
  NoHandlerError,
  UnknownChannelError,
  type IpcErrorCode,
} from './errors';
export { IpcRegistry, type IpcCallContext, type IpcHandler } from './registry';
export {
  createIpcClient,
  type IpcClient,
  type IpcClientOptions,
  type IpcTransport,
} from './client';

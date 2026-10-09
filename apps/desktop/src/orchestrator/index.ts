import { randomUUID } from 'node:crypto';
import {
  Orchestrator,
  RpcPeer,
  type ApproveInput,
  type OrchestratorPorts,
  type RpcTransport,
  type SessionSnapshot,
  type TurnRequest,
} from '@sheep/orchestrator';

/**
 * The orchestrator, in its own process.
 *
 * It runs here rather than in main for one reason that matters: a protocol
 * session is long, and the work between two model calls — clustering, scoring,
 * solving roles — is synchronous CPU. Done on main's thread it would block
 * every IPC reply and freeze the window; done here it cannot, and closing the
 * window does not end the session either.
 *
 * It owns nothing. The database handle and the adapter registry stay in main,
 * because two owners of either would be two answers to what happened and what
 * it cost, so every port below is a call back across the same channel that
 * carries commands in.
 */

const parentPort = process.parentPort;

const transport: RpcTransport = {
  post(message) {
    parentPort.postMessage(message);
  },
  onMessage(listener) {
    parentPort.on('message', (event) => {
      listener(event.data);
    });
  },
};

const peer = new RpcPeer(transport, {
  onError(error) {
    process.stderr.write(`sheep-orchestrator: ${error.message}\n`);
  },
});

const ports: OrchestratorPorts = {
  snapshot: (sessionId) => peer.call<SessionSnapshot>('snapshot', { sessionId }),
  record: async (sessionId, events) => {
    await peer.call('record', { sessionId, events });
  },
  ask: (sessionId, request: TurnRequest) => peer.call('ask', { sessionId, request }),
  execute: (sessionId, request) => peer.call('execute', { sessionId, request }),
  check: (sessionId, request) => peer.call('check', { sessionId, request }),
  newId: () => randomUUID(),
  progress: (update) => {
    peer.notify('progress', update);
  },
};

const orchestrator = new Orchestrator(ports);

peer
  .handle('ping', () => ({ pid: process.pid }))
  .handle('run', (params) => orchestrator.run(sessionIdOf(params)))
  .handle('approve', (params) => {
    const input = params as { sessionId?: unknown; input?: ApproveInput };
    if (!input.input) throw new Error('approve requires a decision');
    return orchestrator.approve(sessionIdOf(params), input.input);
  })
  .handle('cancel', (params) => {
    orchestrator.cancel(sessionIdOf(params));
    return { cancelled: true };
  })
  .handle('view', (params) => orchestrator.view(sessionIdOf(params)));

function sessionIdOf(params: unknown): string {
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('sessionId is required');
  }
  return sessionId;
}

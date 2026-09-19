import { createInsertOperation, ROOT_ID } from '@lfcw/crdt';
import { E2E_BACKEND_HOST, E2E_BACKEND_PORT } from '../fixtures/backend';

const SYNC_URL = `ws://${E2E_BACKEND_HOST}:${E2E_BACKEND_PORT}/sync`;

export interface SeededHistory {
  readonly lastOpId: string;
  readonly lastServerSeq: number;
  readonly text: string;
}

export async function seedSequentialHistory(
  documentId: string,
  count: number,
  options: {
    readonly startCounter?: number;
    readonly afterId?: string;
    readonly lastServerSeq?: number;
    readonly value?: string;
  } = {},
): Promise<SeededHistory> {
  const startCounter = options.startCounter ?? 1;
  const value = options.value ?? 'a';
  const socket = new WebSocket(SYNC_URL);
  await waitForOpen(socket);

  try {
    const sync = await sendJoin(socket, documentId, options.lastServerSeq ?? 0);
    let lastServerSeq = sync.latestServerSeq;
    let afterId = options.afterId ?? ROOT_ID;
    let lastOpId = afterId;

    for (let offset = 0; offset < count; offset += 1) {
      const counter = startCounter + offset;
      const operation = createInsertOperation({
        clientId: 'e2e-seed',
        counter,
        lamport: counter,
        afterId,
        value,
      });
      const accepted = waitForOperation(socket, operation.opId);
      socket.send(
        JSON.stringify({
          type: 'submit-operation',
          documentId,
          operation,
        }),
      );
      lastServerSeq = (await accepted).serverSeq;
      afterId = operation.opId;
      lastOpId = operation.opId;
    }

    return {
      lastOpId,
      lastServerSeq,
      text: value.repeat(count),
    };
  } finally {
    socket.close();
  }
}

interface SyncLike {
  readonly type: string;
  readonly latestServerSeq: number;
}

interface OperationLike {
  readonly type: string;
  readonly serverSeq: number;
  readonly operation: { readonly opId: string };
}

function sendJoin(socket: WebSocket, documentId: string, lastServerSeq: number): Promise<SyncLike> {
  const sync = waitForMessage<SyncLike>(socket, (message) => message.type === 'sync');
  socket.send(
    JSON.stringify({
      type: 'join',
      documentId,
      clientId: 'e2e-seed',
      lastServerSeq,
    }),
  );
  return sync;
}

function waitForOperation(socket: WebSocket, opId: string): Promise<OperationLike> {
  return waitForMessage(
    socket,
    (message): message is OperationLike =>
      message.type === 'operation' && (message as OperationLike).operation?.opId === opId,
  );
}

function waitForOpen(socket: WebSocket, timeoutMs = 5_000): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for seed WebSocket open.'));
    }, timeoutMs);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Seed WebSocket failed to open.'));
    });
  });
}

function waitForMessage<T extends { type: string }>(
  socket: WebSocket,
  predicate: (message: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('Timed out waiting for a seed WebSocket message.'));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as T;

      if (!predicate(message)) {
        return;
      }

      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      resolve(message);
    };

    socket.addEventListener('message', onMessage);
  });
}

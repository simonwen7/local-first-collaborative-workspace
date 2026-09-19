import { afterEach, describe, expect, it } from 'vitest';
import { ROOT_ID, createInsertOperation } from '@lfcw/crdt';
import type { ErrorMessage, OperationMessage, SyncMessage } from '@lfcw/protocol';
import { SNAPSHOT_BOOTSTRAP_CAPABILITY } from '@lfcw/protocol';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import type { CreatedApp } from '../src/app.js';
import { SNAPSHOT_OPERATION_THRESHOLD } from '../src/server-snapshot.js';
import type { OperationStore } from '../src/operation-store.js';

const documentId = 'local-default-document';

const insertA = createInsertOperation({
  clientId: 'client-a',
  counter: 1,
  lamport: 1,
  afterId: ROOT_ID,
  value: 'A',
});

interface RunningServer {
  readonly created: CreatedApp;
  readonly port: number;
}

async function startServer(): Promise<RunningServer> {
  const created = await createApp({
    databasePath: ':memory:',
  });

  await created.app.listen({
    host: '127.0.0.1',
    port: 0,
  });

  const address = created.app.server.address();

  if (typeof address !== 'object' || address === null) {
    throw new Error('Expected a TCP listen address.');
  }

  return {
    created,
    port: address.port,
  };
}

async function openClient(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/sync`);
  await waitForOpen(socket);
  return socket;
}

async function joinDocument(
  socket: WebSocket,
  clientId: string,
  joinDocumentId = documentId,
  lastServerSeq = 0,
  capabilities?: readonly string[],
): Promise<SyncMessage> {
  const sync = waitForMessage<SyncMessage>(socket, (message) => message.type === 'sync');

  socket.send(
    JSON.stringify({
      type: 'join',
      documentId: joinDocumentId,
      clientId,
      lastServerSeq,
      ...(capabilities ? { capabilities } : {}),
    }),
  );

  return sync;
}

function waitForOpen(socket: WebSocket, timeoutMs = 2000): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for WebSocket open.'));
    }, timeoutMs);

    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });

    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForMessage<T extends { type: string }>(
  socket: WebSocket,
  predicate: (message: T) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for an expected WebSocket message.'));
    }, timeoutMs);

    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as T;

      if (!predicate(message)) {
        return;
      }

      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };

    socket.on('message', onMessage);
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    socket.once('close', () => {
      resolve();
    });
    socket.close();
  });
}

describe('collaboration server', () => {
  let running: RunningServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((socket) => closeSocket(socket)));

    if (running) {
      await running.created.app.close();
      running = undefined;
    }
  });

  it('keeps GET /health available', async () => {
    running = await startServer();

    const response = await fetch(`http://127.0.0.1:${running.port}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('joins, broadcasts an accepted insert, persists it, and replays it to a later client', async () => {
    running = await startServer();

    const clientA = await openClient(running.port);
    const clientB = await openClient(running.port);
    sockets.push(clientA, clientB);

    const syncA = await joinDocument(clientA, 'client-a');
    const syncB = await joinDocument(clientB, 'client-b');

    expect(syncA).toMatchObject({
      type: 'sync',
      documentId,
      operations: [],
      latestServerSeq: 0,
    });
    expect(syncB.operations).toEqual([]);

    const echoA = waitForMessage<OperationMessage>(
      clientA,
      (message) => message.type === 'operation' && message.operation.opId === insertA.opId,
    );
    const liveB = waitForMessage<OperationMessage>(
      clientB,
      (message) => message.type === 'operation' && message.operation.opId === insertA.opId,
    );

    clientA.send(
      JSON.stringify({
        type: 'submit-operation',
        documentId,
        operation: insertA,
      }),
    );

    const [acceptedA, acceptedB] = await Promise.all([echoA, liveB]);

    expect(acceptedA).toEqual(acceptedB);
    expect(acceptedA.serverSeq).toBeGreaterThan(0);
    expect(acceptedA.operation).toEqual(insertA);

    const persisted = running.created.store.loadOperations(documentId);

    expect(persisted).toEqual([
      {
        serverSeq: acceptedA.serverSeq,
        operation: insertA,
      },
    ]);

    const clientC = await openClient(running.port);
    sockets.push(clientC);

    const syncC = await joinDocument(clientC, 'client-c');

    expect(syncC.latestServerSeq).toBe(acceptedA.serverSeq);
    expect(syncC.operations).toEqual([
      {
        serverSeq: acceptedA.serverSeq,
        operation: insertA,
      },
    ]);

    const otherClient = await openClient(running.port);
    sockets.push(otherClient);

    await joinDocument(otherClient, 'other-client', 'other-document');

    const otherMessages: unknown[] = [];
    otherClient.on('message', (raw) => {
      otherMessages.push(JSON.parse(raw.toString()));
    });

    const insertB = createInsertOperation({
      clientId: 'client-a',
      counter: 2,
      lamport: 2,
      afterId: insertA.opId,
      value: 'B',
    });

    const secondEcho = waitForMessage<OperationMessage>(
      clientA,
      (message) => message.type === 'operation' && message.operation.opId === insertB.opId,
    );
    const secondLiveB = waitForMessage<OperationMessage>(
      clientB,
      (message) => message.type === 'operation' && message.operation.opId === insertB.opId,
    );

    clientA.send(
      JSON.stringify({
        type: 'submit-operation',
        documentId,
        operation: insertB,
      }),
    );

    await Promise.all([secondEcho, secondLiveB]);

    const duplicateEcho = waitForMessage<OperationMessage>(
      clientA,
      (message) => message.type === 'operation' && message.operation.opId === insertA.opId,
    );

    clientA.send(
      JSON.stringify({
        type: 'submit-operation',
        documentId,
        operation: insertA,
      }),
    );

    const duplicate = await duplicateEcho;

    expect(duplicate.serverSeq).toBe(acceptedA.serverSeq);
    expect(running.created.store.loadOperations(documentId)).toHaveLength(2);

    const conflict = waitForMessage<ErrorMessage>(clientA, (message) => message.type === 'error');

    clientA.send(
      JSON.stringify({
        type: 'submit-operation',
        documentId,
        operation: createInsertOperation({
          clientId: 'client-a',
          counter: 1,
          lamport: 8,
          afterId: ROOT_ID,
          value: 'Z',
        }),
      }),
    );

    const conflictError = await conflict;

    expect(conflictError.code).toBe('IDENTITY_CONFLICT');
    expect(running.created.store.loadOperations(documentId)).toHaveLength(2);
    expect(
      otherMessages.filter((message) => (message as { type?: string }).type === 'operation'),
    ).toEqual([]);
  });

  it('serves incremental join history, empty catch-up, and cursor-ahead errors', async () => {
    running = await startServer();

    const clientA = await openClient(running.port);
    sockets.push(clientA);
    await joinDocument(clientA, 'client-a', documentId, 0);

    clientA.send(
      JSON.stringify({
        type: 'submit-operation',
        documentId,
        operation: insertA,
      }),
    );
    const first = await waitForMessage<OperationMessage>(
      clientA,
      (message) => message.type === 'operation' && message.operation.opId === insertA.opId,
    );

    const insertB = createInsertOperation({
      clientId: 'client-a',
      counter: 2,
      lamport: 2,
      afterId: insertA.opId,
      value: 'B',
    });
    clientA.send(
      JSON.stringify({
        type: 'submit-operation',
        documentId,
        operation: insertB,
      }),
    );
    const second = await waitForMessage<OperationMessage>(
      clientA,
      (message) => message.type === 'operation' && message.operation.opId === insertB.opId,
    );

    const other = createInsertOperation({
      clientId: 'other-client',
      counter: 1,
      lamport: 1,
      afterId: ROOT_ID,
      value: 'Z',
    });
    const otherClient = await openClient(running.port);
    sockets.push(otherClient);
    await joinDocument(otherClient, 'other-client', 'other-document', 0);
    otherClient.send(
      JSON.stringify({
        type: 'submit-operation',
        documentId: 'other-document',
        operation: other,
      }),
    );
    await waitForMessage<OperationMessage>(
      otherClient,
      (message) => message.type === 'operation' && message.operation.opId === other.opId,
    );

    const clientB = await openClient(running.port);
    sockets.push(clientB);
    const syncB = await joinDocument(clientB, 'client-b', documentId, 0);
    expect(syncB.operations.map((item) => item.operation.opId)).toEqual([
      insertA.opId,
      insertB.opId,
    ]);
    expect(syncB.latestServerSeq).toBe(second.serverSeq);

    const clientC = await openClient(running.port);
    sockets.push(clientC);
    const syncC = await joinDocument(clientC, 'client-c', documentId, first.serverSeq);
    expect(syncC.operations).toEqual([
      {
        serverSeq: second.serverSeq,
        operation: insertB,
      },
    ]);

    const clientD = await openClient(running.port);
    sockets.push(clientD);
    const syncD = await joinDocument(clientD, 'client-d', documentId, second.serverSeq);
    expect(syncD.operations).toEqual([]);
    expect(syncD.latestServerSeq).toBe(second.serverSeq);

    const ahead = await openClient(running.port);
    sockets.push(ahead);
    const aheadError = waitForMessage<ErrorMessage>(ahead, (message) => message.type === 'error');
    ahead.send(
      JSON.stringify({
        type: 'join',
        documentId,
        clientId: 'client-ahead',
        lastServerSeq: second.serverSeq + 10,
      }),
    );
    expect((await aheadError).code).toBe('sync-cursor-ahead');
  });

  it('sends full operation history to an M7-style client even when a snapshot exists', async () => {
    running = await startServer();
    seedResolvedHistory(running.created.store, documentId, SNAPSHOT_OPERATION_THRESHOLD);

    const capable = await openClient(running.port);
    sockets.push(capable);
    const capableSync = await joinDocument(capable, 'client-capable', documentId, 0, [
      SNAPSHOT_BOOTSTRAP_CAPABILITY,
    ]);
    expect(capableSync.snapshotBootstrap).toBeDefined();
    expect(capableSync.operations).toEqual([]);

    const legacy = await openClient(running.port);
    sockets.push(legacy);
    const legacySync = await joinDocument(legacy, 'client-legacy');
    expect(legacySync.snapshotBootstrap).toBeUndefined();
    expect(legacySync.operations).toHaveLength(SNAPSHOT_OPERATION_THRESHOLD);
  });

  it('sends snapshot plus suffix to a capable cursor-0 client', async () => {
    running = await startServer();
    const last = seedResolvedHistory(
      running.created.store,
      documentId,
      SNAPSHOT_OPERATION_THRESHOLD,
    );
    const warmup = await openClient(running.port);
    sockets.push(warmup);
    await joinDocument(warmup, 'warmup', documentId, 0, [SNAPSHOT_BOOTSTRAP_CAPABILITY]);

    running.created.store.appendOperation(
      documentId,
      createInsertOperation({
        clientId: 'suffix',
        counter: 1,
        lamport: SNAPSHOT_OPERATION_THRESHOLD + 1,
        afterId: last.opId,
        value: 'z',
      }),
    );

    const client = await openClient(running.port);
    sockets.push(client);
    const sync = await joinDocument(client, 'client-b', documentId, 0, [
      SNAPSHOT_BOOTSTRAP_CAPABILITY,
    ]);
    expect(sync.snapshotBootstrap?.snapshotSeq).toBe(SNAPSHOT_OPERATION_THRESHOLD);
    expect(sync.operations).toHaveLength(1);
    expect(sync.operations[0]?.operation.value).toBe('z');
    expect(sync.latestServerSeq).toBe(running.created.store.getLatestServerSeq(documentId));
  });

  it('does not snapshot a capable client when document history is below the threshold', async () => {
    running = await startServer();
    seedResolvedHistory(running.created.store, documentId, 3);

    const client = await openClient(running.port);
    sockets.push(client);
    const sync = await joinDocument(client, 'client-small', documentId, 0, [
      SNAPSHOT_BOOTSTRAP_CAPABILITY,
    ]);
    expect(sync.snapshotBootstrap).toBeUndefined();
    expect(sync.operations).toHaveLength(3);
  });

  it('uses incremental operation catch-up for a capable client with cursor > 0', async () => {
    running = await startServer();
    seedResolvedHistory(running.created.store, documentId, SNAPSHOT_OPERATION_THRESHOLD);
    const warmup = await openClient(running.port);
    sockets.push(warmup);
    await joinDocument(warmup, 'warmup', documentId, 0, [SNAPSHOT_BOOTSTRAP_CAPABILITY]);

    const client = await openClient(running.port);
    sockets.push(client);
    const sync = await joinDocument(client, 'behind', documentId, 10, [
      SNAPSHOT_BOOTSTRAP_CAPABILITY,
    ]);
    expect(sync.snapshotBootstrap).toBeUndefined();
    expect(sync.operations.length).toBe(SNAPSHOT_OPERATION_THRESHOLD - 10);
    expect(sync.operations[0]?.serverSeq).toBe(11);
  });
});

function seedResolvedHistory(store: OperationStore, seedDocumentId: string, count: number) {
  let afterId = ROOT_ID;
  let last = createInsertOperation({
    clientId: 'seed',
    counter: 1,
    lamport: 1,
    afterId,
    value: 'a',
  });

  for (let counter = 1; counter <= count; counter += 1) {
    last = createInsertOperation({
      clientId: 'seed',
      counter,
      lamport: counter,
      afterId,
      value: 'a',
    });
    store.appendOperation(seedDocumentId, last);
    afterId = last.opId;
  }

  return last;
}

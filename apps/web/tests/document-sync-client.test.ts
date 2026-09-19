import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROOT_ID, createInsertOperation } from '@lfcw/crdt';
import { SNAPSHOT_BOOTSTRAP_CAPABILITY } from '@lfcw/protocol';
import {
  InvalidSnapshotBootstrapError,
  SnapshotBootstrapIneligibleError,
} from '../src/persistence/local-document-store';
import { DocumentSyncClient } from '../src/sync/document-sync-client';
import type { SyncStatus } from '../src/sync/document-sync-client';

const pendingOp = createInsertOperation({
  clientId: 'client-a',
  counter: 1,
  lamport: 1,
  afterId: ROOT_ID,
  value: 'A',
});

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }

    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  emitError(): void {
    this.emit('error');
  }

  emitMessage(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  private emit(type: string, event: { data?: string } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);

  if (!socket) {
    throw new Error('Expected a FakeWebSocket instance.');
  }

  return socket;
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

async function flush(client?: DocumentSyncClient): Promise<void> {
  await drainMicrotasks();

  if (client) {
    await (client as unknown as { inbound: Promise<void> }).inbound;
    await drainMicrotasks();
  }
}

describe('DocumentSyncClient', () => {
  const statuses: SyncStatus[] = [];

  beforeEach(() => {
    FakeWebSocket.instances = [];
    statuses.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createClient(
    overrides: Partial<ConstructorParameters<typeof DocumentSyncClient>[0]> = {},
  ): DocumentSyncClient {
    return new DocumentSyncClient({
      documentId: 'local-default-document',
      clientId: 'client-a',
      getLastServerSeq: async () => 4,
      loadPendingOperations: async () => [],
      onServerOperations: async () => undefined,
      onStatusChange: (status) => {
        statuses.push(status);
      },
      ...overrides,
    });
  }

  it('sends join with the persisted lastServerSeq after the socket opens', async () => {
    const client = createClient();
    client.connect();
    lastSocket().open();
    await flush(client);

    expect(lastSocket().sent).toEqual([
      {
        type: 'join',
        documentId: 'local-default-document',
        clientId: 'client-a',
        lastServerSeq: 4,
      },
    ]);
  });

  it('ingests sync before flushing the durable outbox and stays syncing until the outbox is empty', async () => {
    const order: string[] = [];
    let pending = [pendingOp];

    const client = createClient({
      getLastServerSeq: async () => 0,
      loadPendingOperations: async () => {
        order.push('load-pending');
        return pending;
      },
      onServerOperations: async (operations, confirmed) => {
        order.push(`ingest:${confirmed}:${operations.length}`);
        if (operations.some((item) => item.operation.opId === pendingOp.opId)) {
          pending = [];
        }
      },
    });

    client.connect();
    lastSocket().open();
    await flush(client);
    lastSocket().emitMessage({
      type: 'sync',
      documentId: 'local-default-document',
      operations: [],
      latestServerSeq: 0,
    });
    await flush(client);

    expect(order[0]).toBe('ingest:0:0');
    expect(order).toContain('load-pending');
    expect(
      lastSocket().sent.some(
        (message) => (message as { type?: string }).type === 'submit-operation',
      ),
    ).toBe(true);
    expect(client.getStatus()).toBe('syncing');

    lastSocket().emitMessage({
      type: 'operation',
      documentId: 'local-default-document',
      serverSeq: 1,
      operation: pendingOp,
    });
    await flush(client);

    expect(client.getStatus()).toBe('online');
  });

  it('does not send local operations until catch-up completes', async () => {
    const client = createClient({
      getLastServerSeq: async () => 0,
    });

    client.connect();
    client.submitOperations([pendingOp]);
    lastSocket().open();
    await flush(client);
    expect(lastSocket().sent).toEqual([expect.objectContaining({ type: 'join' })]);

    lastSocket().emitMessage({
      type: 'sync',
      documentId: 'local-default-document',
      operations: [],
      latestServerSeq: 0,
    });
    await flush(client);
    expect(client.getStatus()).toBe('online');

    client.submitOperations([pendingOp]);
    expect(lastSocket().sent.at(-1)).toMatchObject({
      type: 'submit-operation',
      operation: pendingOp,
    });
    expect(client.getStatus()).toBe('syncing');
  });

  it('does not send local operations while offline', () => {
    const client = createClient();
    client.submitOperations([pendingOp]);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('schedules deterministic reconnect delays and resets the count after catch-up', async () => {
    const client = createClient({
      getLastServerSeq: async () => 0,
    });

    client.connect();
    lastSocket().open();
    await flush(client);
    lastSocket().close();
    expect(client.getStatus()).toBe('offline');

    await vi.advanceTimersByTimeAsync(249);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    lastSocket().close();
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    lastSocket().close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(4);

    lastSocket().close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWebSocket.instances).toHaveLength(5);

    lastSocket().close();
    await vi.advanceTimersByTimeAsync(4000);
    expect(FakeWebSocket.instances).toHaveLength(6);

    lastSocket().close();
    await vi.advanceTimersByTimeAsync(4000);
    expect(FakeWebSocket.instances).toHaveLength(7);

    lastSocket().open();
    await flush(client);
    lastSocket().emitMessage({
      type: 'sync',
      documentId: 'local-default-document',
      operations: [],
      latestServerSeq: 0,
    });
    await flush(client);

    lastSocket().close();
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeWebSocket.instances).toHaveLength(8);
  });

  it('cancels reconnect on explicit close and does not open a second socket for error-then-close', async () => {
    const client = createClient({
      getLastServerSeq: async () => 0,
    });

    client.connect();
    lastSocket().open();
    await flush(client);
    lastSocket().emitError();
    lastSocket().close();
    expect(FakeWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(FakeWebSocket.instances).toHaveLength(2);

    client.close();
    expect(client.getStatus()).toBe('offline');
    await vi.advanceTimersByTimeAsync(4000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('serializes inbound message processing', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstIngest = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: number[] = [];
    const finished: number[] = [];
    let ingestCount = 0;

    const client = createClient({
      getLastServerSeq: async () => 0,
      onServerOperations: async (_operations, confirmed) => {
        ingestCount += 1;
        started.push(confirmed);
        if (ingestCount === 1) {
          await firstIngest;
        }
        finished.push(confirmed);
      },
    });

    client.connect();
    lastSocket().open();
    await flush(client);
    lastSocket().emitMessage({
      type: 'sync',
      documentId: 'local-default-document',
      operations: [],
      latestServerSeq: 0,
    });
    lastSocket().emitMessage({
      type: 'operation',
      documentId: 'local-default-document',
      serverSeq: 2,
      operation: pendingOp,
    });
    await drainMicrotasks();

    expect(started).toEqual([0]);
    expect(finished).toEqual([]);

    releaseFirst?.();
    await flush(client);

    expect(started).toEqual([0, 2]);
    expect(finished).toEqual([0, 2]);
  });

  it('does not keep a memory-only startup queue', async () => {
    const client = createClient({
      getLastServerSeq: async () => 0,
      loadPendingOperations: async () => [pendingOp],
    });

    client.connect();
    client.submitOperations([pendingOp]);
    lastSocket().open();
    await flush(client);
    expect(lastSocket().sent).toEqual([expect.objectContaining({ type: 'join' })]);

    lastSocket().emitMessage({
      type: 'sync',
      documentId: 'local-default-document',
      operations: [],
      latestServerSeq: 0,
    });
    await flush(client);

    expect(
      lastSocket().sent.filter(
        (message) => (message as { type?: string }).type === 'submit-operation',
      ),
    ).toHaveLength(1);
    expect(client).not.toHaveProperty('startupQueue');
  });

  it('advertises snapshot bootstrap only for a pristine cursor-0 document', async () => {
    const capable = createClient({
      getLastServerSeq: async () => 0,
      isSnapshotBootstrapEligible: async () => true,
    });
    capable.connect();
    lastSocket().open();
    await flush(capable);
    expect(lastSocket().sent[0]).toEqual({
      type: 'join',
      documentId: 'local-default-document',
      clientId: 'client-a',
      lastServerSeq: 0,
      capabilities: [SNAPSHOT_BOOTSTRAP_CAPABILITY],
    });

    const behind = createClient({
      getLastServerSeq: async () => 4,
      isSnapshotBootstrapEligible: async () => true,
    });
    behind.connect();
    lastSocket().open();
    await flush(behind);
    expect(lastSocket().sent[0]).not.toHaveProperty('capabilities');
  });

  it('installs a snapshot bootstrap sync and still accepts operations-only sync', async () => {
    const bootstraps: unknown[] = [];
    const operationsIngests: number[] = [];
    const snapshot = { version: 1, nodes: [], deleteOperations: [] };

    const client = createClient({
      getLastServerSeq: async () => 0,
      isSnapshotBootstrapEligible: async () => true,
      onSnapshotBootstrap: async (bootstrap, operations, latest) => {
        bootstraps.push({ bootstrap, operations, latest });
      },
      onServerOperations: async (_operations, confirmed) => {
        operationsIngests.push(confirmed);
      },
    });

    client.connect();
    lastSocket().open();
    await flush(client);
    lastSocket().emitMessage({
      type: 'sync',
      documentId: 'local-default-document',
      operations: [
        {
          serverSeq: 5,
          operation: pendingOp,
        },
      ],
      latestServerSeq: 5,
      snapshotBootstrap: {
        version: 1,
        snapshotSeq: 4,
        snapshot,
      },
    });
    await flush(client);
    expect(bootstraps).toHaveLength(1);
    expect(operationsIngests).toEqual([]);
    expect(client.getStatus()).toBe('online');
    client.close();

    const legacy = createClient({
      getLastServerSeq: async () => 0,
      onServerOperations: async (_operations, confirmed) => {
        operationsIngests.push(confirmed);
      },
    });
    legacy.connect();
    lastSocket().open();
    await flush(legacy);
    lastSocket().emitMessage({
      type: 'sync',
      documentId: 'local-default-document',
      operations: [],
      latestServerSeq: 0,
    });
    await flush(legacy);
    expect(operationsIngests).toEqual([0]);
  });

  it('reconnects without snapshot capability after a local-edit race rejects install', async () => {
    let eligible = true;
    const pending = [pendingOp];
    const ingested: number[] = [];

    const client = createClient({
      getLastServerSeq: async () => 0,
      isSnapshotBootstrapEligible: async () => eligible,
      loadPendingOperations: async () => pending,
      onSnapshotBootstrap: async () => {
        throw new SnapshotBootstrapIneligibleError('local edit');
      },
      onServerOperations: async (_operations, confirmed) => {
        ingested.push(confirmed);
      },
    });

    client.connect();
    lastSocket().open();
    await flush(client);
    expect(lastSocket().sent[0]).toMatchObject({
      capabilities: [SNAPSHOT_BOOTSTRAP_CAPABILITY],
    });

    eligible = false;
    lastSocket().emitMessage({
      type: 'sync',
      documentId: 'local-default-document',
      operations: [],
      latestServerSeq: 4,
      snapshotBootstrap: {
        version: 1,
        snapshotSeq: 4,
        snapshot: { version: 1, nodes: [], deleteOperations: [] },
      },
    });
    await flush(client);

    await vi.advanceTimersByTimeAsync(250);
    expect(FakeWebSocket.instances).toHaveLength(2);
    lastSocket().open();
    await flush(client);
    expect(lastSocket().sent[0]).toEqual({
      type: 'join',
      documentId: 'local-default-document',
      clientId: 'client-a',
      lastServerSeq: 0,
    });

    lastSocket().emitMessage({
      type: 'sync',
      documentId: 'local-default-document',
      operations: [],
      latestServerSeq: 1,
    });
    await flush(client);
    expect(ingested).toEqual([1]);
    expect(
      lastSocket().sent.some(
        (message) => (message as { type?: string }).type === 'submit-operation',
      ),
    ).toBe(true);
  });

  it('falls back once for a malformed snapshot and does not loop', async () => {
    const client = createClient({
      getLastServerSeq: async () => 0,
      isSnapshotBootstrapEligible: async () => true,
      onSnapshotBootstrap: async () => {
        throw new InvalidSnapshotBootstrapError('corrupt');
      },
    });

    client.connect();
    lastSocket().open();
    await flush(client);
    lastSocket().emitMessage({
      type: 'sync',
      documentId: 'local-default-document',
      operations: [],
      latestServerSeq: 1,
      snapshotBootstrap: {
        version: 1,
        snapshotSeq: 1,
        snapshot: { version: 1, nodes: [], deleteOperations: [] },
      },
    });
    await flush(client);
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeWebSocket.instances).toHaveLength(2);
    lastSocket().open();
    await flush(client);
    expect(lastSocket().sent[0]).not.toHaveProperty('capabilities');

    lastSocket().emitMessage({
      type: 'sync',
      documentId: 'local-default-document',
      operations: [],
      latestServerSeq: 0,
    });
    await flush(client);
    expect(client.getStatus()).toBe('online');
    await vi.advanceTimersByTimeAsync(4000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

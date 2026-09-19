import { describe, expect, it } from 'vitest';
import { ROOT_ID, TextReplica, createInsertOperation } from '@lfcw/crdt';
import type { TextReplicaSnapshot } from '@lfcw/crdt';
import { ServerMetrics } from '../src/observability/server-metrics.js';
import { OperationStore } from '../src/operation-store.js';
import { SNAPSHOT_OPERATION_THRESHOLD, ServerSnapshotManager } from '../src/server-snapshot.js';

const silentLogger = {
  info(): void {},
  warn(): void {},
};

function sequentialInserts(count: number, clientId = 'seed', startCounter = 1, afterId = ROOT_ID) {
  const operations = [];
  let anchor = afterId;

  for (let offset = 0; offset < count; offset += 1) {
    const counter = startCounter + offset;
    const operation = createInsertOperation({
      clientId,
      counter,
      lamport: counter,
      afterId: anchor,
      value: 'a',
    });
    operations.push(operation);
    anchor = operation.opId;
  }

  return operations;
}

function appendAll(
  store: OperationStore,
  documentId: string,
  operations: ReturnType<typeof sequentialInserts>,
): void {
  for (const operation of operations) {
    store.appendOperation(documentId, operation);
  }
}

function createManager(store: OperationStore, metrics = new ServerMetrics()) {
  return new ServerSnapshotManager(store, metrics, silentLogger);
}

describe('ServerSnapshotManager', () => {
  it('keeps the snapshot table empty until a capable join crosses the threshold', () => {
    const store = new OperationStore(':memory:');
    const manager = createManager(store);
    appendAll(store, 'doc-a', sequentialInserts(SNAPSHOT_OPERATION_THRESHOLD - 1));

    const sync = manager.buildSyncMessage('doc-a', 0, true);
    expect(sync.snapshotBootstrap).toBeUndefined();
    expect(sync.operations).toHaveLength(SNAPSHOT_OPERATION_THRESHOLD - 1);
    expect(store.loadSnapshotRow('doc-a')).toBeUndefined();
    store.close();
  });

  it('builds a snapshot at the document barrier and validates the stored CRDT payload', () => {
    const store = new OperationStore(':memory:');
    const manager = createManager(store);
    appendAll(store, 'doc-a', sequentialInserts(SNAPSHOT_OPERATION_THRESHOLD));
    const barrier = store.getLatestServerSeq('doc-a');

    const sync = manager.buildSyncMessage('doc-a', 0, true);
    expect(sync.snapshotBootstrap?.version).toBe(1);
    expect(sync.snapshotBootstrap?.snapshotSeq).toBe(barrier);
    expect(sync.operations).toEqual([]);
    expect(sync.latestServerSeq).toBe(barrier);

    const row = store.loadSnapshotRow('doc-a');
    expect(row?.snapshotSeq).toBe(barrier);
    const snapshot = JSON.parse(row?.snapshotJson ?? 'null') as TextReplicaSnapshot;
    const restored = TextReplica.fromSnapshot(snapshot);
    expect(restored.materialize()).toBe('a'.repeat(SNAPSHOT_OPERATION_THRESHOLD));
    store.close();
  });

  it('reuses a snapshot when the document suffix count is below the threshold', () => {
    const store = new OperationStore(':memory:');
    const manager = createManager(store);
    const prefix = sequentialInserts(SNAPSHOT_OPERATION_THRESHOLD);
    appendAll(store, 'doc-a', prefix);
    const first = manager.buildSyncMessage('doc-a', 0, true);
    const snapshotSeq = first.snapshotBootstrap?.snapshotSeq;
    expect(snapshotSeq).toBeDefined();

    appendAll(store, 'doc-a', sequentialInserts(3, 'suffix', 1, prefix.at(-1)!.opId));

    const second = manager.buildSyncMessage('doc-a', 0, true);
    expect(second.snapshotBootstrap?.snapshotSeq).toBe(snapshotSeq);
    expect(second.operations).toHaveLength(3);
    expect(second.latestServerSeq).toBe(store.getLatestServerSeq('doc-a'));
    expect(store.loadOperations('doc-a')).toHaveLength(SNAPSHOT_OPERATION_THRESHOLD + 3);
    store.close();
  });

  it('refreshes the snapshot after at least 1000 additional document operations', () => {
    const store = new OperationStore(':memory:');
    const manager = createManager(store);
    const prefix = sequentialInserts(SNAPSHOT_OPERATION_THRESHOLD);
    appendAll(store, 'doc-a', prefix);
    const first = manager.buildSyncMessage('doc-a', 0, true);
    expect(first.snapshotBootstrap?.snapshotSeq).toBe(SNAPSHOT_OPERATION_THRESHOLD);

    appendAll(
      store,
      'doc-a',
      sequentialInserts(SNAPSHOT_OPERATION_THRESHOLD, 'later', 1, prefix.at(-1)!.opId),
    );
    const barrier = store.getLatestServerSeq('doc-a');
    const refreshed = manager.buildSyncMessage('doc-a', 0, true);
    expect(refreshed.snapshotBootstrap?.snapshotSeq).toBe(barrier);
    expect(refreshed.operations).toEqual([]);
    expect(store.loadSnapshotRow('doc-a')?.snapshotSeq).toBe(barrier);
    store.close();
  });

  it('uses document operation counts rather than global serverSeq gaps', () => {
    const store = new OperationStore(':memory:');
    const manager = createManager(store);
    store.appendOperation(
      'other',
      createInsertOperation({
        clientId: 'other',
        counter: 1,
        lamport: 1,
        afterId: ROOT_ID,
        value: 'x',
      }),
    );
    const prefix = sequentialInserts(SNAPSHOT_OPERATION_THRESHOLD - 1);
    appendAll(store, 'doc-a', prefix);

    const below = manager.buildSyncMessage('doc-a', 0, true);
    expect(below.snapshotBootstrap).toBeUndefined();
    expect(store.countOperations('doc-a')).toBe(SNAPSHOT_OPERATION_THRESHOLD - 1);
    expect(store.getLatestServerSeq('doc-a')).toBeGreaterThan(store.countOperations('doc-a'));

    appendAll(
      store,
      'doc-a',
      sequentialInserts(1, 'seed', SNAPSHOT_OPERATION_THRESHOLD, prefix.at(-1)!.opId),
    );
    const capable = manager.buildSyncMessage('doc-a', 0, true);
    expect(capable.snapshotBootstrap).toBeDefined();
    store.close();
  });

  it('does not store a row when a prefix cannot export a resolved snapshot', () => {
    const store = new OperationStore(':memory:');
    const metrics = new ServerMetrics();
    const failing = new ServerSnapshotManager(store, metrics, silentLogger);

    for (let i = 1; i <= SNAPSHOT_OPERATION_THRESHOLD; i += 1) {
      store.appendOperation(
        'doc-a',
        createInsertOperation({
          clientId: 'broken',
          counter: i,
          lamport: i,
          afterId: 'missing:1',
          value: 'x',
        }),
      );
    }

    const sync = failing.buildSyncMessage('doc-a', 0, true);
    expect(sync.snapshotBootstrap).toBeUndefined();
    expect(sync.operations).toHaveLength(SNAPSHOT_OPERATION_THRESHOLD);
    expect(store.loadSnapshotRow('doc-a')).toBeUndefined();
    expect(metrics.snapshot().snapshotBuildFailuresTotal).toBe(1);
    store.close();
  });

  it('ignores a corrupt cached snapshot and rebuilds from retained history', () => {
    const store = new OperationStore(':memory:');
    const manager = createManager(store);
    appendAll(store, 'doc-a', sequentialInserts(SNAPSHOT_OPERATION_THRESHOLD));
    manager.buildSyncMessage('doc-a', 0, true);
    store.saveSnapshotRow({
      documentId: 'doc-a',
      snapshotSeq: store.getLatestServerSeq('doc-a'),
      snapshotVersion: 1,
      snapshotJson: '{not-json',
      createdAt: Date.now(),
    });

    const rebuilt = manager.buildSyncMessage('doc-a', 0, true);
    expect(rebuilt.snapshotBootstrap).toBeDefined();
    const row = store.loadSnapshotRow('doc-a');
    expect(() => JSON.parse(row?.snapshotJson ?? '')).not.toThrow();
    TextReplica.fromSnapshot(JSON.parse(row?.snapshotJson ?? 'null') as TextReplicaSnapshot);
    expect(store.loadOperations('doc-a')).toHaveLength(SNAPSHOT_OPERATION_THRESHOLD);
    store.close();
  });
});

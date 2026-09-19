import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { ROOT_ID, TextReplica, createInsertOperation } from '@lfcw/crdt';
import { CLIENT_META_KEY, LocalWorkspaceDatabase } from '../src/persistence/database';
import { DEFAULT_DOCUMENT_ID, LocalDocumentStore } from '../src/persistence/local-document-store';
import { InvalidServerBaselineError } from '../src/persistence/local-document-store';
import {
  LocalDocumentController,
  SNAPSHOT_OPERATION_INTERVAL,
} from '../src/replica/local-document-controller';

function uniqueDatabaseName(label: string): string {
  return `lfcw-controller-test-${label}-${crypto.randomUUID()}`;
}

describe('LocalDocumentController', () => {
  it('reconstructs local text after closing and reopening the client', async () => {
    const databaseName = uniqueDatabaseName('reload');

    const first = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-a',
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const firstEdit = await first.replaceText('协作👨‍👩‍👧‍👦');
    expect(firstEdit.snapshot.text).toBe('协作👨‍👩‍👧‍👦');
    expect(firstEdit.operations.length).toBeGreaterThan(0);
    expect(first.getSnapshot().text).toBe('协作👨‍👩‍👧‍👦');

    await first.close();

    const reopened = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'should-not-replace-client-id',
      now: () => '2026-01-01T00:00:01.000Z',
    });

    expect(reopened.getSnapshot().text).toBe('协作👨‍👩‍👧‍👦');

    await reopened.replaceText('协作👨‍👩‍👧‍👦!');

    expect(reopened.getSnapshot().text).toBe('协作👨‍👩‍👧‍👦!');

    await reopened.close();

    const cleanupDatabase = new LocalWorkspaceDatabase(databaseName);

    await cleanupDatabase.delete();
  });

  it('serializes rapid requested edits against one local replica', async () => {
    const databaseName = uniqueDatabaseName('queue');

    const controller = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-q',
      now: () => '2026-01-01T00:00:00.000Z',
    });

    await Promise.all([
      controller.replaceText('H'),
      controller.replaceText('He'),
      controller.replaceText('Hel'),
      controller.replaceText('Hell'),
      controller.replaceText('Hello'),
    ]);

    expect(controller.getSnapshot().text).toBe('Hello');

    await controller.close();

    const reopened = await LocalDocumentController.create({
      databaseName,
    });

    expect(reopened.getSnapshot().text).toBe('Hello');

    await reopened.close();

    const cleanupDatabase = new LocalWorkspaceDatabase(databaseName);

    await cleanupDatabase.delete();
  });

  it('supports local replacement and deletion without a server', async () => {
    const databaseName = uniqueDatabaseName('replace-delete');

    const controller = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-edit',
    });

    await controller.replaceText('ABC');
    await controller.replaceText('AXC');
    await controller.replaceText('AC');

    expect(controller.getSnapshot().text).toBe('AC');

    await controller.close();

    const cleanupDatabase = new LocalWorkspaceDatabase(databaseName);

    await cleanupDatabase.delete();
  });

  it('applies remote operations through the same write queue and preserves identity', async () => {
    const databaseName = uniqueDatabaseName('remote-ingest');

    const controller = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-local',
    });

    expect(controller.getIdentity()).toEqual({
      documentId: 'local-default-document',
      clientId: 'client-local',
    });

    const remoteOperation = createInsertOperation({
      clientId: 'client-remote',
      counter: 1,
      lamport: 20,
      afterId: ROOT_ID,
      value: 'R',
    });

    expect(await controller.getLastServerSeq()).toBe(0);

    const remoteSnapshot = await controller.applyServerOperations(
      [{ serverSeq: 2, operation: remoteOperation }],
      2,
    );

    expect(remoteSnapshot.text).toBe('R');
    expect(await controller.getLastServerSeq()).toBe(2);

    const localEdit = await controller.replaceText('RL');

    expect(localEdit.snapshot.text).toBe('RL');
    expect(localEdit.operations).toHaveLength(1);
    expect(localEdit.operations[0]?.lamport).toBeGreaterThan(20);
    expect(localEdit.operations[0]?.clientId).toBe('client-local');
    expect(await controller.loadPendingOperations()).toEqual(localEdit.operations);

    await controller.close();

    const cleanupDatabase = new LocalWorkspaceDatabase(databaseName);

    await cleanupDatabase.delete();
  });

  it('rejects an invalid checkpoint interval', async () => {
    await expect(
      LocalDocumentController.create({
        snapshotInterval: 0,
      }),
    ).rejects.toThrow('snapshotInterval must be a positive safe integer.');

    expect(SNAPSHOT_OPERATION_INTERVAL).toBe(1000);
  });

  it('reconstructs from the canonical log when no checkpoint exists', async () => {
    const databaseName = uniqueDatabaseName('no-checkpoint');
    const first = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-a',
    });
    await first.replaceText('Hi');
    await first.close();

    const database = new LocalWorkspaceDatabase(databaseName);
    const store = new LocalDocumentStore(database);
    expect(await store.loadReplicaSnapshot(DEFAULT_DOCUMENT_ID)).toBeUndefined();
    store.close();

    const reopened = await LocalDocumentController.create({ databaseName });
    expect(reopened.getSnapshot().text).toBe('Hi');
    await reopened.close();
    await database.delete();
  });

  it('restores a valid checkpoint and reapplies the canonical log', async () => {
    const databaseName = uniqueDatabaseName('valid-checkpoint');
    const first = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-a',
      snapshotInterval: 1,
    });
    await first.replaceText('AB');
    await first.close();

    const database = new LocalWorkspaceDatabase(databaseName);
    const store = new LocalDocumentStore(database);
    const checkpoint = await store.loadReplicaSnapshot(DEFAULT_DOCUMENT_ID);
    expect(checkpoint?.knownOperationCount).toBe(2);
    const operations = await store.loadOperations(DEFAULT_DOCUMENT_ID);
    store.close();

    const reopened = await LocalDocumentController.create({ databaseName });
    expect(reopened.getSnapshot().text).toBe('AB');
    expect(reopened.getSnapshot().visibleElements.map((element) => element.id)).toEqual(
      operations.map((operation) => operation.opId),
    );
    await reopened.close();
    await database.delete();
  });

  it('applies operations created after a stale checkpoint', async () => {
    const databaseName = uniqueDatabaseName('stale-checkpoint');
    const first = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-a',
      snapshotInterval: 2,
    });
    await first.replaceText('AB');
    await first.replaceText('ABC');
    await first.close();

    const database = new LocalWorkspaceDatabase(databaseName);
    const store = new LocalDocumentStore(database);
    expect((await store.loadReplicaSnapshot(DEFAULT_DOCUMENT_ID))?.knownOperationCount).toBe(2);
    store.close();

    const reopened = await LocalDocumentController.create({ databaseName });
    expect(reopened.getSnapshot().text).toBe('ABC');
    await reopened.close();
    await database.delete();
  });

  it('rejects a checkpoint that contains an extra historical operation', async () => {
    const databaseName = uniqueDatabaseName('extra-op');
    const first = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-a',
    });
    await first.replaceText('A');
    await first.close();

    const extra = createInsertOperation({
      clientId: 'ghost',
      counter: 1,
      lamport: 9,
      afterId: ROOT_ID,
      value: 'G',
    });
    const replica = new TextReplica();
    replica.apply(
      createInsertOperation({
        clientId: 'client-a',
        counter: 1,
        lamport: 1,
        afterId: ROOT_ID,
        value: 'A',
      }),
    );
    replica.apply(extra);

    const database = new LocalWorkspaceDatabase(databaseName);
    const store = new LocalDocumentStore(database);
    await store.saveReplicaSnapshot(DEFAULT_DOCUMENT_ID, replica.exportSnapshot(), 2);
    store.close();

    const reopened = await LocalDocumentController.create({ databaseName });
    expect(reopened.getSnapshot().text).toBe('A');
    await reopened.close();
    await database.delete();
  });

  it('rejects a checkpoint whose payload conflicts with the canonical log', async () => {
    const databaseName = uniqueDatabaseName('conflict-checkpoint');
    const first = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-a',
    });
    await first.replaceText('A');
    await first.close();

    const conflicting = new TextReplica();
    conflicting.apply(
      createInsertOperation({
        clientId: 'client-a',
        counter: 1,
        lamport: 1,
        afterId: ROOT_ID,
        value: 'Z',
      }),
    );

    const database = new LocalWorkspaceDatabase(databaseName);
    const store = new LocalDocumentStore(database);
    await store.saveReplicaSnapshot(DEFAULT_DOCUMENT_ID, conflicting.exportSnapshot(), 1);
    store.close();

    const reopened = await LocalDocumentController.create({ databaseName });
    expect(reopened.getSnapshot().text).toBe('A');
    await reopened.close();
    await database.delete();
  });

  it('still fails startup when the canonical log remains unresolved', async () => {
    const databaseName = uniqueDatabaseName('unresolved');
    const first = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-a',
    });
    await first.close();

    const database = new LocalWorkspaceDatabase(databaseName);
    await database.open();
    await database.operations.add({
      opId: 'client-a:1',
      documentId: DEFAULT_DOCUMENT_ID,
      operation: createInsertOperation({
        clientId: 'client-a',
        counter: 1,
        lamport: 1,
        afterId: 'missing:1',
        value: 'X',
      }),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    database.close();

    await expect(LocalDocumentController.create({ databaseName })).rejects.toThrow(
      'Stored local operation log has unresolved dependencies',
    );

    await new LocalWorkspaceDatabase(databaseName).delete();
  });

  it('reconstructs a migrated v2 document and becomes eligible for a checkpoint', async () => {
    const databaseName = uniqueDatabaseName('v2-startup');
    const legacy = new Dexie(databaseName);
    legacy.version(2).stores({
      clientMeta: '&key',
      documents: '&id, updatedAt',
      operations: '&opId, documentId, createdAt',
      outbox: '&opId, documentId, createdAt',
      syncState: '&documentId',
    });

    const localOperation = createInsertOperation({
      clientId: 'client-v2',
      counter: 1,
      lamport: 1,
      afterId: ROOT_ID,
      value: 'L',
    });

    await legacy.open();
    await legacy.table('clientMeta').add({
      key: CLIENT_META_KEY,
      clientId: 'client-v2',
      nextCounter: 2,
      lamportClock: 1,
    });
    await legacy.table('documents').add({
      id: DEFAULT_DOCUMENT_ID,
      title: 'Local Document',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await legacy.table('operations').add({
      opId: localOperation.opId,
      documentId: DEFAULT_DOCUMENT_ID,
      operation: localOperation,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await legacy.table('outbox').add({
      opId: localOperation.opId,
      documentId: DEFAULT_DOCUMENT_ID,
      createdAt: 1,
    });
    await legacy.table('syncState').add({
      documentId: DEFAULT_DOCUMENT_ID,
      lastServerSeq: 0,
    });
    legacy.close();

    const controller = await LocalDocumentController.create({
      databaseName,
      snapshotInterval: 1,
    });
    expect(controller.getSnapshot().text).toBe('L');
    expect(await controller.loadPendingOperations()).toEqual([localOperation]);
    expect(await controller.getLastServerSeq()).toBe(0);
    await controller.close();

    const database = new LocalWorkspaceDatabase(databaseName);
    const store = new LocalDocumentStore(database);
    expect((await store.loadReplicaSnapshot(DEFAULT_DOCUMENT_ID))?.knownOperationCount).toBe(1);
    expect(await store.loadPendingOperations(DEFAULT_DOCUMENT_ID)).toEqual([localOperation]);
    expect(await store.loadOperations(DEFAULT_DOCUMENT_ID)).toEqual([localOperation]);
    store.close();
    await database.delete();
  });

  it('creates and replaces checkpoints on the injected interval', async () => {
    const databaseName = uniqueDatabaseName('interval');
    const controller = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-a',
      snapshotInterval: 3,
    });

    await controller.replaceText('A');
    const database = new LocalWorkspaceDatabase(databaseName);
    const store = new LocalDocumentStore(database);
    expect(await store.loadReplicaSnapshot(DEFAULT_DOCUMENT_ID)).toBeUndefined();

    await controller.replaceText('ABC');
    expect((await store.loadReplicaSnapshot(DEFAULT_DOCUMENT_ID))?.knownOperationCount).toBe(3);

    await controller.replaceText('ABCD');
    expect((await store.loadReplicaSnapshot(DEFAULT_DOCUMENT_ID))?.knownOperationCount).toBe(3);

    await controller.replaceText('ABCDEF');
    expect((await store.loadReplicaSnapshot(DEFAULT_DOCUMENT_ID))?.knownOperationCount).toBe(6);

    await controller.close();
    store.close();
    await database.delete();
  });

  it('counts remote operations toward the checkpoint interval', async () => {
    const databaseName = uniqueDatabaseName('remote-interval');
    const controller = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-local',
      snapshotInterval: 3,
    });

    await controller.applyServerOperations(
      [
        {
          serverSeq: 1,
          operation: createInsertOperation({
            clientId: 'client-remote',
            counter: 1,
            lamport: 1,
            afterId: ROOT_ID,
            value: 'R',
          }),
        },
        {
          serverSeq: 2,
          operation: createInsertOperation({
            clientId: 'client-remote',
            counter: 2,
            lamport: 2,
            afterId: 'client-remote:1',
            value: 'S',
          }),
        },
      ],
      2,
    );

    const database = new LocalWorkspaceDatabase(databaseName);
    const store = new LocalDocumentStore(database);
    expect(await store.loadReplicaSnapshot(DEFAULT_DOCUMENT_ID)).toBeUndefined();

    await controller.replaceText('RST');
    expect((await store.loadReplicaSnapshot(DEFAULT_DOCUMENT_ID))?.knownOperationCount).toBe(3);
    expect(await store.getLastServerSeq(DEFAULT_DOCUMENT_ID)).toBe(2);

    await controller.close();
    store.close();
    await database.delete();
  });

  it('skips checkpoint creation while the replica is unresolved', async () => {
    const databaseName = uniqueDatabaseName('unresolved-skip');
    let checkpointAttempts = 0;
    const controller = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-local',
      snapshotInterval: 1,
      persistCheckpoint: async () => {
        checkpointAttempts += 1;
      },
    });

    await controller.applyServerOperations(
      [
        {
          serverSeq: 1,
          operation: createInsertOperation({
            clientId: 'client-remote',
            counter: 1,
            lamport: 1,
            afterId: 'missing:1',
            value: 'X',
          }),
        },
      ],
      1,
    );

    expect(checkpointAttempts).toBe(0);
    expect(controller.getSnapshot().text).toBe('');

    await controller.close();
    await new LocalWorkspaceDatabase(databaseName).delete();
  });

  it('does not fail a successful local edit when checkpoint persistence fails', async () => {
    const databaseName = uniqueDatabaseName('checkpoint-fail');
    const saved: number[] = [];
    let attempts = 0;
    const controller = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-a',
      snapshotInterval: 1,
      persistCheckpoint: async (_documentId, _snapshot, knownOperationCount) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('checkpoint cache write failed');
        }

        saved.push(knownOperationCount);
      },
    });

    const first = await controller.replaceText('A');
    expect(first.snapshot.text).toBe('A');
    expect(saved).toEqual([]);

    const second = await controller.replaceText('AB');
    expect(second.snapshot.text).toBe('AB');
    expect(saved).toEqual([2]);

    await controller.close();
    await new LocalWorkspaceDatabase(databaseName).delete();
  });

  it('does not drain or mutate the outbox when a checkpoint is created', async () => {
    const databaseName = uniqueDatabaseName('outbox-safe');
    const controller = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-a',
      snapshotInterval: 1,
    });

    const edit = await controller.replaceText('A');
    expect(await controller.loadPendingOperations()).toEqual(edit.operations);

    await controller.close();

    const reopened = await LocalDocumentController.create({ databaseName });
    expect(await reopened.loadPendingOperations()).toEqual(edit.operations);
    expect(reopened.getSnapshot().text).toBe('A');
    await reopened.close();

    await new LocalWorkspaceDatabase(databaseName).delete();
  });

  it('creates isolated controllers and closes them after queued writes settle', async () => {
    const databaseName = uniqueDatabaseName('lifecycle');
    const documentA = crypto.randomUUID();
    const documentB = crypto.randomUUID();

    const controllerA = await LocalDocumentController.create({
      databaseName,
      documentId: documentA,
      clientIdFactory: () => 'client-shared',
      snapshotInterval: 1,
    });
    const controllerB = await LocalDocumentController.create({
      databaseName,
      documentId: documentB,
      clientIdFactory: () => 'should-not-replace',
    });

    const writeA = controllerA.replaceText('AAA');
    const idle = controllerA.whenIdle();
    await writeA;
    await idle;
    const queued = controllerA.replaceText('AAAA');
    const closing = controllerA.close();
    await queued;
    await closing;
    expect(controllerA.getSnapshot().text).toBe('AAAA');
    expect(controllerB.getSnapshot().text).toBe('');

    await controllerA.close();
    await expect(controllerA.replaceText('Z')).rejects.toMatchObject({
      name: 'ControllerClosedError',
    });

    await controllerB.replaceText('B');
    expect(controllerB.getSnapshot().text).toBe('B');
    await controllerB.close();

    const store = new LocalDocumentStore(new LocalWorkspaceDatabase(databaseName));
    expect((await store.loadReplicaSnapshot(documentA))?.knownOperationCount).toBe(4);
    expect(await store.loadReplicaSnapshot(documentB)).toBeUndefined();
    store.close();
    await new LocalWorkspaceDatabase(databaseName).delete();
  });

  it('installs a server baseline, reloads from baseline plus local suffix, and skips M4 checkpoints', async () => {
    const databaseName = uniqueDatabaseName('baseline');
    const controller = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-local',
      snapshotInterval: 1,
    });
    expect(await controller.isSnapshotBootstrapEligible()).toBe(true);

    const prefix = createInsertOperation({
      clientId: 'seed',
      counter: 1,
      lamport: 8,
      afterId: ROOT_ID,
      value: 'A',
    });
    const replica = new TextReplica();
    replica.apply(prefix);
    const suffix = createInsertOperation({
      clientId: 'seed',
      counter: 2,
      lamport: 9,
      afterId: prefix.opId,
      value: 'B',
    });

    const installed = await controller.installServerSnapshot(
      { version: 1, snapshotSeq: 1, snapshot: replica.exportSnapshot() },
      [{ serverSeq: 2, operation: suffix }],
      2,
    );
    expect(installed.text).toBe('AB');
    expect(await controller.isSnapshotBootstrapEligible()).toBe(false);

    const local = await controller.replaceText('ABC');
    expect(local.snapshot.text).toBe('ABC');
    expect(local.operations).toHaveLength(1);
    await controller.close();

    const store = new LocalDocumentStore(new LocalWorkspaceDatabase(databaseName));
    expect(await store.loadOperations(DEFAULT_DOCUMENT_ID)).toHaveLength(2);
    expect(await store.loadServerBaseline(DEFAULT_DOCUMENT_ID)).toMatchObject({ snapshotSeq: 1 });
    expect(await store.loadReplicaSnapshot(DEFAULT_DOCUMENT_ID)).toBeUndefined();
    store.close();

    const reopened = await LocalDocumentController.create({
      databaseName,
      snapshotInterval: 1,
    });
    expect(reopened.getSnapshot().text).toBe('ABC');
    expect(await reopened.loadPendingOperations()).toEqual(local.operations);
    await reopened.replaceText('ABCD');
    await reopened.close();

    const after = new LocalDocumentStore(new LocalWorkspaceDatabase(databaseName));
    expect(await after.loadReplicaSnapshot(DEFAULT_DOCUMENT_ID)).toBeUndefined();
    after.close();
    await new LocalWorkspaceDatabase(databaseName).delete();
  });

  it('fails loudly on a malformed authoritative baseline', async () => {
    const databaseName = uniqueDatabaseName('bad-baseline');
    const controller = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-local',
    });
    const prefix = createInsertOperation({
      clientId: 'seed',
      counter: 1,
      lamport: 1,
      afterId: ROOT_ID,
      value: 'A',
    });
    const replica = new TextReplica();
    replica.apply(prefix);
    await controller.installServerSnapshot(
      { version: 1, snapshotSeq: 1, snapshot: replica.exportSnapshot() },
      [],
      1,
    );
    await controller.close();

    const database = new LocalWorkspaceDatabase(databaseName);
    await database.open();
    await database.serverBaselines.put({
      documentId: DEFAULT_DOCUMENT_ID,
      snapshotSeq: 1,
      snapshot: {
        version: 1,
        nodes: [
          {
            id: 'seed:1',
            afterId: 'missing:1',
            value: 'A',
            clientId: 'seed',
            counter: 1,
            lamport: 1,
            tombstone: false,
          },
        ],
        deleteOperations: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    database.close();

    await expect(LocalDocumentController.create({ databaseName })).rejects.toBeInstanceOf(
      InvalidServerBaselineError,
    );
    await new LocalWorkspaceDatabase(databaseName).delete();
  });

  it('treats a local edit as making snapshot bootstrap ineligible', async () => {
    const databaseName = uniqueDatabaseName('eligible-edit');
    const controller = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'client-local',
    });
    expect(await controller.isSnapshotBootstrapEligible()).toBe(true);
    await controller.replaceText('Hi');
    expect(await controller.isSnapshotBootstrapEligible()).toBe(false);
    await controller.close();
    await new LocalWorkspaceDatabase(databaseName).delete();
  });
});

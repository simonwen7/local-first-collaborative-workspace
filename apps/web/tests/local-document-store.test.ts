import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { OperationIdentityConflictError, ROOT_ID, createInsertOperation } from '@lfcw/crdt';
import { CLIENT_META_KEY, LocalWorkspaceDatabase } from '../src/persistence/database';
import { LocalDocumentStore } from '../src/persistence/local-document-store';

function uniqueDatabaseName(label: string): string {
  return `lfcw-test-${label}-${crypto.randomUUID()}`;
}

describe('LocalDocumentStore', () => {
  it('persists one stable client identity across repeated initialization', async () => {
    const databaseName = uniqueDatabaseName('identity');

    let factoryCalls = 0;

    const firstDatabase = new LocalWorkspaceDatabase(databaseName);

    const firstStore = new LocalDocumentStore(firstDatabase, {
      clientIdFactory: () => {
        factoryCalls += 1;
        return 'client-stable';
      },
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const first = await firstStore.initialize();
    firstStore.close();

    const secondDatabase = new LocalWorkspaceDatabase(databaseName);

    const secondStore = new LocalDocumentStore(secondDatabase, {
      clientIdFactory: () => {
        factoryCalls += 1;
        return 'client-should-not-replace';
      },
      now: () => '2026-01-01T00:00:01.000Z',
    });

    const second = await secondStore.initialize();

    expect(first.clientMeta.clientId).toBe('client-stable');
    expect(second.clientMeta.clientId).toBe('client-stable');
    expect(factoryCalls).toBe(1);
    expect(await secondStore.getLastServerSeq(second.document.id)).toBe(0);

    await secondDatabase.delete();
  });

  it('creates local operations and outbox markers atomically', async () => {
    const database = new LocalWorkspaceDatabase(uniqueDatabaseName('operations'));

    const store = new LocalDocumentStore(database, {
      clientIdFactory: () => 'client-a',
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const initialized = await store.initialize();

    const operations = await store.persistLocalTextEdit(initialized.document.id, {
      deleteTargetIds: [],
      insertAfterId: ROOT_ID,
      insertValues: ['H', 'i'],
    });

    expect(operations.map((operation) => operation.opId)).toEqual(['client-a:1', 'client-a:2']);
    expect(operations.map((operation) => operation.lamport)).toEqual([1, 2]);

    const pending = await store.loadPendingOperations(initialized.document.id);
    expect(pending).toEqual(operations);
    expect(pending.map((operation) => operation.counter)).toEqual([1, 2]);

    const meta = await store.readClientMeta();
    expect(meta.nextCounter).toBe(3);
    expect(meta.lamportClock).toBe(2);
    expect(await store.loadOperations(initialized.document.id)).toHaveLength(2);

    await database.delete();
  });

  it('persists sequenced server operations, advances the cursor, and acks matching outbox rows', async () => {
    const database = new LocalWorkspaceDatabase(uniqueDatabaseName('remote-ops'));

    const store = new LocalDocumentStore(database, {
      clientIdFactory: () => 'client-local',
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const initialized = await store.initialize();
    const remoteOperation = createInsertOperation({
      clientId: 'client-remote',
      counter: 4,
      lamport: 11,
      afterId: ROOT_ID,
      value: 'R',
    });

    await store.persistServerOperations(
      initialized.document.id,
      [{ serverSeq: 3, operation: remoteOperation }],
      3,
    );

    expect(await store.loadOperations(initialized.document.id)).toEqual([remoteOperation]);
    expect(await store.getLastServerSeq(initialized.document.id)).toBe(3);
    expect((await store.readClientMeta()).nextCounter).toBe(1);
    expect((await store.readClientMeta()).lamportClock).toBe(11);

    await store.persistServerOperations(
      initialized.document.id,
      [{ serverSeq: 3, operation: remoteOperation }],
      3,
    );
    expect(await store.loadOperations(initialized.document.id)).toHaveLength(1);
    expect(await store.getLastServerSeq(initialized.document.id)).toBe(3);

    await expect(
      store.persistServerOperations(
        initialized.document.id,
        [
          {
            serverSeq: 4,
            operation: createInsertOperation({
              clientId: 'client-remote',
              counter: 4,
              lamport: 12,
              afterId: ROOT_ID,
              value: 'X',
            }),
          },
        ],
        4,
      ),
    ).rejects.toBeInstanceOf(OperationIdentityConflictError);
    expect(await store.getLastServerSeq(initialized.document.id)).toBe(3);

    const localOperations = await store.persistLocalTextEdit(initialized.document.id, {
      deleteTargetIds: [],
      insertAfterId: remoteOperation.opId,
      insertValues: ['L'],
    });

    expect(localOperations[0]?.lamport).toBeGreaterThan(11);
    expect(await store.loadPendingOperations(initialized.document.id)).toEqual(localOperations);

    await store.persistServerOperations(
      initialized.document.id,
      [{ serverSeq: 8, operation: localOperations[0]! }],
      8,
    );

    expect(await store.loadPendingOperations(initialized.document.id)).toEqual([]);
    expect(await store.loadOperations(initialized.document.id)).toHaveLength(2);
    expect(await store.getLastServerSeq(initialized.document.id)).toBe(8);

    await database.delete();
  });

  it('rolls back cursor and outbox changes when a server batch fails', async () => {
    const database = new LocalWorkspaceDatabase(uniqueDatabaseName('txn-fail'));
    const store = new LocalDocumentStore(database, {
      clientIdFactory: () => 'client-local',
    });
    const initialized = await store.initialize();

    const local = await store.persistLocalTextEdit(initialized.document.id, {
      deleteTargetIds: [],
      insertAfterId: ROOT_ID,
      insertValues: ['A'],
    });

    await expect(
      store.persistServerOperations(
        initialized.document.id,
        [
          {
            serverSeq: 1,
            operation: createInsertOperation({
              clientId: 'client-local',
              counter: 1,
              lamport: 9,
              afterId: ROOT_ID,
              value: 'Z',
            }),
          },
        ],
        1,
      ),
    ).rejects.toBeInstanceOf(OperationIdentityConflictError);

    expect(await store.getLastServerSeq(initialized.document.id)).toBe(0);
    expect(await store.loadPendingOperations(initialized.document.id)).toEqual(local);
    expect(await store.loadOperations(initialized.document.id)).toEqual(local);

    await database.delete();
  });

  it('clears an outbox row when reconnect replay repeats an already-local operation', async () => {
    const database = new LocalWorkspaceDatabase(uniqueDatabaseName('replay-ack'));
    const store = new LocalDocumentStore(database, {
      clientIdFactory: () => 'client-local',
    });
    const initialized = await store.initialize();
    const [local] = await store.persistLocalTextEdit(initialized.document.id, {
      deleteTargetIds: [],
      insertAfterId: ROOT_ID,
      insertValues: ['A'],
    });

    await store.persistServerOperations(
      initialized.document.id,
      [{ serverSeq: 5, operation: local! }],
      5,
    );

    expect(await store.loadPendingOperations(initialized.document.id)).toEqual([]);
    expect(await store.loadOperations(initialized.document.id)).toHaveLength(1);
    expect(await store.getLastServerSeq(initialized.document.id)).toBe(5);

    await database.delete();
  });

  it('migrates a v1 database onto outbox and syncState without rewriting history', async () => {
    const databaseName = uniqueDatabaseName('migrate');
    const legacy = new Dexie(databaseName);
    legacy.version(1).stores({
      clientMeta: '&key',
      documents: '&id, updatedAt',
      operations: '&opId, documentId, createdAt',
    });

    const localOperation = createInsertOperation({
      clientId: 'client-legacy',
      counter: 1,
      lamport: 1,
      afterId: ROOT_ID,
      value: 'L',
    });
    const remoteOperation = createInsertOperation({
      clientId: 'client-remote',
      counter: 1,
      lamport: 4,
      afterId: localOperation.opId,
      value: 'R',
    });

    await legacy.open();
    await legacy.table('clientMeta').add({
      key: CLIENT_META_KEY,
      clientId: 'client-legacy',
      nextCounter: 2,
      lamportClock: 4,
    });
    await legacy.table('documents').add({
      id: 'local-default-document',
      title: 'Local Document',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await legacy.table('operations').bulkAdd([
      {
        opId: localOperation.opId,
        documentId: 'local-default-document',
        operation: localOperation,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        opId: remoteOperation.opId,
        documentId: 'local-default-document',
        operation: remoteOperation,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    legacy.close();

    const upgraded = new LocalWorkspaceDatabase(databaseName);
    const store = new LocalDocumentStore(upgraded, {
      clientIdFactory: () => 'should-not-replace',
    });
    await store.initialize();

    expect(await store.loadOperations('local-default-document')).toEqual([
      localOperation,
      remoteOperation,
    ]);
    expect(await store.getLastServerSeq('local-default-document')).toBe(0);
    expect(await store.loadPendingOperations('local-default-document')).toEqual([localOperation]);

    await upgraded.delete();
  });
});

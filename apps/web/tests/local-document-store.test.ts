import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';
import { OperationIdentityConflictError, ROOT_ID, createInsertOperation } from '@lfcw/crdt';
import { LocalWorkspaceDatabase } from '../src/persistence/database';
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

    await secondDatabase.delete();
  });

  it('persists operations and advances counter and Lamport clock transactionally', async () => {
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

    const meta = await store.readClientMeta();

    expect(meta.nextCounter).toBe(3);
    expect(meta.lamportClock).toBe(2);

    const reloaded = await store.loadOperations(initialized.document.id);

    expect(reloaded).toHaveLength(2);

    await database.delete();
  });

  it('persists remote operations unchanged without consuming the local counter', async () => {
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

    await store.persistRemoteOperations(initialized.document.id, [remoteOperation]);

    const stored = await store.loadOperations(initialized.document.id);
    const metaAfterRemote = await store.readClientMeta();

    expect(stored).toEqual([remoteOperation]);
    expect(stored[0]?.clientId).toBe('client-remote');
    expect(stored[0]?.counter).toBe(4);
    expect(stored[0]?.opId).toBe('client-remote:4');
    expect(metaAfterRemote.nextCounter).toBe(1);
    expect(metaAfterRemote.lamportClock).toBe(11);

    await store.persistRemoteOperations(initialized.document.id, [remoteOperation]);

    expect(await store.loadOperations(initialized.document.id)).toHaveLength(1);
    expect((await store.readClientMeta()).nextCounter).toBe(1);

    await expect(
      store.persistRemoteOperations(initialized.document.id, [
        createInsertOperation({
          clientId: 'client-remote',
          counter: 4,
          lamport: 12,
          afterId: ROOT_ID,
          value: 'X',
        }),
      ]),
    ).rejects.toBeInstanceOf(OperationIdentityConflictError);

    const localOperations = await store.persistLocalTextEdit(initialized.document.id, {
      deleteTargetIds: [],
      insertAfterId: remoteOperation.opId,
      insertValues: ['L'],
    });

    expect(localOperations).toHaveLength(1);
    expect(localOperations[0]?.lamport).toBeGreaterThan(11);
    expect(localOperations[0]?.clientId).toBe('client-local');
    expect(localOperations[0]?.counter).toBe(1);
    expect((await store.readClientMeta()).nextCounter).toBe(2);

    await database.delete();
  });
});

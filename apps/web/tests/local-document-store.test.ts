import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';
import { ROOT_ID } from '@lfcw/crdt';
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
});

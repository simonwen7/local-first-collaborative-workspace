import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT_ID, createInsertOperation, OperationIdentityConflictError } from '@lfcw/crdt';
import { OperationStore } from '../src/operation-store.js';

const firstInsert = createInsertOperation({
  clientId: 'client-a',
  counter: 1,
  lamport: 1,
  afterId: ROOT_ID,
  value: 'A',
});

const secondInsert = createInsertOperation({
  clientId: 'client-a',
  counter: 2,
  lamport: 2,
  afterId: firstInsert.opId,
  value: 'B',
});

describe('OperationStore', () => {
  const stores: OperationStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) {
      store.close();
    }
  });

  it('assigns increasing serverSeq values and returns history in that order', () => {
    const store = new OperationStore(':memory:');
    stores.push(store);

    const first = store.appendOperation('doc-a', firstInsert);
    const second = store.appendOperation('doc-a', secondInsert);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(second.serverSeq).toBeGreaterThan(first.serverSeq);

    expect(store.loadOperations('doc-a')).toEqual([
      { serverSeq: first.serverSeq, operation: firstInsert },
      { serverSeq: second.serverSeq, operation: secondInsert },
    ]);

    expect(store.getLatestServerSeq('doc-a')).toBe(second.serverSeq);
    expect(store.getLatestServerSeq('missing')).toBe(0);
  });

  it('loads incremental history with a fixed barrier and ignores other-document gaps', () => {
    const store = new OperationStore(':memory:');
    stores.push(store);

    const first = store.appendOperation('doc-a', firstInsert);
    const other = createInsertOperation({
      clientId: 'client-other',
      counter: 1,
      lamport: 3,
      afterId: ROOT_ID,
      value: 'X',
    });
    store.appendOperation('doc-b', other);
    const second = store.appendOperation('doc-a', secondInsert);

    expect(store.loadOperationsAfter('doc-a', 0, second.serverSeq)).toEqual([
      { serverSeq: first.serverSeq, operation: firstInsert },
      { serverSeq: second.serverSeq, operation: secondInsert },
    ]);
    expect(store.loadOperationsAfter('doc-a', first.serverSeq, second.serverSeq)).toEqual([
      { serverSeq: second.serverSeq, operation: secondInsert },
    ]);
    expect(store.loadOperationsAfter('doc-a', first.serverSeq, first.serverSeq)).toEqual([]);
    expect(store.loadOperationsAfter('doc-a', second.serverSeq, second.serverSeq)).toEqual([]);

    const onlyFirstBarrier = store.loadOperationsAfter('doc-a', 0, first.serverSeq);
    expect(onlyFirstBarrier).toEqual([{ serverSeq: first.serverSeq, operation: firstInsert }]);
    expect(
      onlyFirstBarrier.every(
        (row, index, rows) => index === 0 || row.serverSeq > rows[index - 1]!.serverSeq,
      ),
    ).toBe(true);
  });

  it('returns the existing sequence for an identical duplicate without inserting again', () => {
    const store = new OperationStore(':memory:');
    stores.push(store);

    const first = store.appendOperation('doc-a', firstInsert);
    const duplicate = store.appendOperation('doc-a', { ...firstInsert });

    expect(duplicate).toEqual({
      serverSeq: first.serverSeq,
      inserted: false,
    });
    expect(store.loadOperations('doc-a')).toHaveLength(1);
  });

  it('throws when the same opId arrives with a different payload', () => {
    const store = new OperationStore(':memory:');
    stores.push(store);

    store.appendOperation('doc-a', firstInsert);

    expect(() =>
      store.appendOperation(
        'doc-a',
        createInsertOperation({
          clientId: 'client-a',
          counter: 1,
          lamport: 9,
          afterId: ROOT_ID,
          value: 'Z',
        }),
      ),
    ).toThrow(OperationIdentityConflictError);

    expect(store.loadOperations('doc-a')).toHaveLength(1);
  });

  it('proves the SQLite connection is usable without mutating operations', () => {
    const store = new OperationStore(':memory:');
    stores.push(store);

    expect(() => store.checkReady()).not.toThrow();
    expect(store.loadOperations('doc-a')).toEqual([]);
    store.appendOperation('doc-a', firstInsert);
    expect(() => store.checkReady()).not.toThrow();
    expect(store.loadOperations('doc-a')).toHaveLength(1);
  });

  it('survives reopening a file-backed SQLite database', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'lfcw-store-'));
    const databasePath = path.join(directory, 'lfcw.sqlite');

    const firstStore = new OperationStore(databasePath);
    const appended = firstStore.appendOperation('doc-a', firstInsert);
    firstStore.close();

    const reopened = new OperationStore(databasePath);

    try {
      expect(reopened.loadOperations('doc-a')).toEqual([
        {
          serverSeq: appended.serverSeq,
          operation: firstInsert,
        },
      ]);
      expect(reopened.getLatestServerSeq('doc-a')).toBe(appended.serverSeq);
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT_ID, createInsertOperation, OperationIdentityConflictError } from '@lfcw/crdt';
import Database from 'better-sqlite3';
import { IncompatibleServerSchemaError, OperationStore } from '../src/operation-store.js';

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

  it('migrates a brand-new database to user_version 2 with an empty snapshot table', () => {
    const store = new OperationStore(':memory:');
    stores.push(store);

    expect(store.getSchemaVersion()).toBe(2);
    expect(store.loadSnapshotRow('doc-a')).toBeUndefined();
    expect(store.loadOperations('doc-a')).toEqual([]);
  });

  it('migrates an existing M7-style operations database without losing rows', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'lfcw-migrate-'));
    const databasePath = path.join(directory, 'lfcw.sqlite');
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        op_id TEXT NOT NULL,
        operation_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (document_id, op_id)
      );
      CREATE INDEX IF NOT EXISTS idx_operations_document_seq
        ON operations (document_id, server_seq);
    `);
    legacy
      .prepare(
        `INSERT INTO operations (document_id, op_id, operation_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('doc-a', firstInsert.opId, JSON.stringify(firstInsert), Date.now());
    expect(Number(legacy.pragma('user_version', { simple: true }))).toBe(0);
    legacy.close();

    const store = new OperationStore(databasePath);

    try {
      expect(store.getSchemaVersion()).toBe(2);
      expect(store.loadOperations('doc-a')).toEqual([{ serverSeq: 1, operation: firstInsert }]);
      expect(store.loadSnapshotRow('doc-a')).toBeUndefined();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses to open a database newer than the supported schema version', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'lfcw-future-'));
    const databasePath = path.join(directory, 'lfcw.sqlite');
    const future = new Database(databasePath);
    future.pragma('user_version = 99');
    future.close();

    expect(() => new OperationStore(databasePath)).toThrow(IncompatibleServerSchemaError);

    rmSync(directory, { recursive: true, force: true });
  });
});

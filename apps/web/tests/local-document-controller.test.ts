import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';
import { ROOT_ID, createInsertOperation } from '@lfcw/crdt';
import { LocalDocumentController } from '../src/replica/local-document-controller';
import { LocalWorkspaceDatabase } from '../src/persistence/database';

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

    first.close();

    const reopened = await LocalDocumentController.create({
      databaseName,
      clientIdFactory: () => 'should-not-replace-client-id',
      now: () => '2026-01-01T00:00:01.000Z',
    });

    expect(reopened.getSnapshot().text).toBe('协作👨‍👩‍👧‍👦');

    await reopened.replaceText('协作👨‍👩‍👧‍👦!');

    expect(reopened.getSnapshot().text).toBe('协作👨‍👩‍👧‍👦!');

    reopened.close();

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

    controller.close();

    const reopened = await LocalDocumentController.create({
      databaseName,
    });

    expect(reopened.getSnapshot().text).toBe('Hello');

    reopened.close();

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

    controller.close();

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

    const remoteSnapshot = await controller.applyRemoteOperations([remoteOperation]);

    expect(remoteSnapshot.text).toBe('R');

    const localEdit = await controller.replaceText('RL');

    expect(localEdit.snapshot.text).toBe('RL');
    expect(localEdit.operations).toHaveLength(1);
    expect(localEdit.operations[0]?.lamport).toBeGreaterThan(20);
    expect(localEdit.operations[0]?.clientId).toBe('client-local');

    controller.close();

    const cleanupDatabase = new LocalWorkspaceDatabase(databaseName);

    await cleanupDatabase.delete();
  });
});

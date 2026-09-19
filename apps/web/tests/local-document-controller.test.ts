import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';
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

    await first.replaceText('协作👨‍👩‍👧‍👦');
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
});

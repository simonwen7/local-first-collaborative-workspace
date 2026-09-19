import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';
import { ROOT_ID, createInsertOperation } from '@lfcw/crdt';
import { LocalWorkspaceDatabase } from '../src/persistence/database';
import { DEFAULT_DOCUMENT_ID, LocalDocumentStore } from '../src/persistence/local-document-store';
import {
  InvalidDocumentTitleError,
  LocalWorkspaceCatalog,
  UNTITLED_DOCUMENT_TITLE,
} from '../src/persistence/local-workspace-catalog';

function uniqueDatabaseName(label: string): string {
  return `lfcw-catalog-${label}-${crypto.randomUUID()}`;
}

describe('LocalWorkspaceCatalog', () => {
  it('ensures the legacy document, creates UUID documents, and lists them deterministically', async () => {
    const databaseName = uniqueDatabaseName('list');
    let clock = 0;
    const catalog = new LocalWorkspaceCatalog({
      databaseName,
      now: () => `2026-01-01T00:00:0${clock++}.000Z`,
    });

    const legacy = await catalog.ensureDocument(DEFAULT_DOCUMENT_ID);
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const [earlierId, laterId] = firstId < secondId ? [firstId, secondId] : [secondId, firstId];
    await catalog.createDocument(laterId, UNTITLED_DOCUMENT_TITLE);
    await catalog.createDocument(earlierId, UNTITLED_DOCUMENT_TITLE);

    const listed = await catalog.listDocuments();
    expect(listed.map((document) => document.id)).toEqual([
      DEFAULT_DOCUMENT_ID,
      laterId,
      earlierId,
    ]);
    expect(legacy.title).toBe('Local Document');
    expect(listed[1]?.title).toBe(UNTITLED_DOCUMENT_TITLE);

    catalog.close();
    await new LocalWorkspaceDatabase(databaseName).delete();
  });

  it('does not overwrite an existing title when creating a duplicate id', async () => {
    const databaseName = uniqueDatabaseName('duplicate');
    const catalog = new LocalWorkspaceCatalog({ databaseName });
    const documentId = crypto.randomUUID();
    await catalog.createDocument(documentId, 'Original');
    const again = await catalog.createDocument(documentId, 'Replacement');
    expect(again.title).toBe('Original');
    catalog.close();
    await new LocalWorkspaceDatabase(databaseName).delete();
  });

  it('renames locally without touching operations, outbox, or syncState', async () => {
    const databaseName = uniqueDatabaseName('rename');
    const catalog = new LocalWorkspaceCatalog({
      databaseName,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const documentId = crypto.randomUUID();
    await catalog.createDocument(documentId, 'Draft');

    const store = new LocalDocumentStore(new LocalWorkspaceDatabase(databaseName), {
      clientIdFactory: () => 'client-a',
    });
    await store.initialize(documentId, 'Draft');
    await store.persistLocalTextEdit(documentId, {
      deleteTargetIds: [],
      insertAfterId: ROOT_ID,
      insertValues: ['A'],
    });
    await store.persistServerOperations(
      documentId,
      [
        {
          serverSeq: 4,
          operation: createInsertOperation({
            clientId: 'remote',
            counter: 1,
            lamport: 9,
            afterId: ROOT_ID,
            value: 'R',
          }),
        },
      ],
      4,
    );

    const opsBefore = await store.loadOperations(documentId);
    const pendingBefore = await store.loadPendingOperations(documentId);
    const cursorBefore = await store.getLastServerSeq(documentId);

    const renamed = await catalog.renameDocument(documentId, '  Renamed Title  ');
    expect(renamed.title).toBe('Renamed Title');

    expect(await store.loadOperations(documentId)).toEqual(opsBefore);
    expect(await store.loadPendingOperations(documentId)).toEqual(pendingBefore);
    expect(await store.getLastServerSeq(documentId)).toBe(cursorBefore);

    await expect(catalog.renameDocument(documentId, '   ')).rejects.toBeInstanceOf(
      InvalidDocumentTitleError,
    );
    await expect(catalog.renameDocument(documentId, 'a'.repeat(81))).rejects.toBeInstanceOf(
      InvalidDocumentTitleError,
    );

    store.close();
    catalog.close();
    await new LocalWorkspaceDatabase(databaseName).delete();
  });
});

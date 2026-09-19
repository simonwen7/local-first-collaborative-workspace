import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/backend';
import { seedSequentialHistory } from './helpers/history';
import { getEditor, waitForLocalSaved, waitForSyncOnline, watchPage } from './helpers/workspace';

const PREFIX_COUNT = 1100;
const SUFFIX_COUNT = 3;

test('bootstraps a fresh client from a server snapshot plus suffix', async ({ page, browser }) => {
  const documentId = crypto.randomUUID();
  const prefix = await seedSequentialHistory(documentId, PREFIX_COUNT);

  watchPage(page);
  await page.goto(`/?document=${documentId}`);
  await expect(page).toHaveURL(new RegExp(`document=${documentId}(?:&|$)`));
  await expect(getEditor(page)).toBeEnabled();
  await waitForLocalSaved(page);
  await waitForSyncOnline(page);
  await expect(getEditor(page)).toHaveValue(prefix.text);

  const persistenceA = await readDocumentPersistence(page, documentId);
  expect(persistenceA.baseline).toBeTruthy();
  expect(persistenceA.baseline?.snapshotSeq).toBe(prefix.lastServerSeq);
  expect(persistenceA.operationCount).toBe(0);
  expect(persistenceA.lastServerSeq).toBe(prefix.lastServerSeq);

  const suffix = await seedSequentialHistory(documentId, SUFFIX_COUNT, {
    startCounter: PREFIX_COUNT + 1,
    afterId: prefix.lastOpId,
    lastServerSeq: prefix.lastServerSeq,
  });

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  watchPage(pageB);

  try {
    await pageB.goto(`/?document=${documentId}`);
    await expect(getEditor(pageB)).toBeEnabled();
    await waitForLocalSaved(pageB);
    await waitForSyncOnline(pageB);
    await expect(getEditor(pageB)).toHaveValue(prefix.text + suffix.text);

    const persistenceB = await readDocumentPersistence(pageB, documentId);
    expect(persistenceB.baseline?.snapshotSeq).toBe(prefix.lastServerSeq);
    expect(persistenceB.operationCount).toBe(SUFFIX_COUNT);
    expect(persistenceB.lastServerSeq).toBe(suffix.lastServerSeq);
  } finally {
    await contextB.close();
  }
});

interface DocumentPersistence {
  readonly operationCount: number;
  readonly lastServerSeq: number;
  readonly baseline: { readonly snapshotSeq: number } | null;
}

async function readDocumentPersistence(
  page: Page,
  documentId: string,
): Promise<DocumentPersistence> {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lfcw-local-workspace');
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('Failed to open IndexedDB.'));
      };
    });

    try {
      const transaction = database.transaction(
        ['operations', 'syncState', 'serverBaselines'],
        'readonly',
      );
      const operationCount = await countByDocument(transaction.objectStore('operations'), id);
      const syncState = await getRecord<{ lastServerSeq: number }>(
        transaction.objectStore('syncState'),
        id,
      );
      const baseline = await getRecord<{ snapshotSeq: number }>(
        transaction.objectStore('serverBaselines'),
        id,
      );

      return {
        operationCount,
        lastServerSeq: syncState?.lastServerSeq ?? 0,
        baseline: baseline ? { snapshotSeq: baseline.snapshotSeq } : null,
      };
    } finally {
      database.close();
    }

    function countByDocument(store: IDBObjectStore, documentKey: string): Promise<number> {
      return new Promise((resolve, reject) => {
        const index = store.index('documentId');
        const request = index.count(IDBKeyRange.only(documentKey));
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error('Failed to count operations.'));
        };
      });
    }

    function getRecord<T>(store: IDBObjectStore, key: string): Promise<T | undefined> {
      return new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => {
          resolve(request.result as T | undefined);
        };
        request.onerror = () => {
          reject(request.error ?? new Error('Failed to read IndexedDB record.'));
        };
      });
    }
  }, documentId);
}

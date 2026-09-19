import {
  createAndRenameDocument,
  documentUrl,
  getCurrentDocumentId,
  getEditor,
  openWorkspace,
  setEditorText,
  waitForLocalSaved,
  waitForSyncDisconnected,
  waitForSyncOnline,
  watchPage,
} from './helpers/workspace';
import { expect, test } from './fixtures/backend';

test('reloads offline edits and flushes the outbox after backend restart', async ({
  page,
  browser,
  backend,
}) => {
  await openWorkspace(page);
  const documentId = await createAndRenameDocument(page, 'Offline Doc');
  await setEditorText(page, 'BASE');
  await waitForSyncOnline(page);

  await backend.stop();
  await waitForSyncDisconnected(page);

  await setEditorText(page, 'BASE-OFFLINE');
  await waitForLocalSaved(page);

  await page.reload();
  await expect(getEditor(page)).toBeEnabled();
  await expect.poll(() => getCurrentDocumentId(page)).toBe(documentId);
  await expect(getEditor(page)).toHaveValue('BASE-OFFLINE');
  await waitForLocalSaved(page);
  await waitForSyncDisconnected(page);

  await backend.restart();
  await waitForSyncOnline(page);
  await expect(getEditor(page)).toHaveValue('BASE-OFFLINE');

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  watchPage(pageB);

  try {
    await pageB.goto(documentUrl(documentId));
    await expect(getEditor(pageB)).toBeEnabled();
    await expect(getEditor(pageB)).toHaveValue('BASE-OFFLINE');
    await waitForLocalSaved(pageB);
    await waitForSyncOnline(pageB);
  } finally {
    await contextB.close();
  }
});

import {
  createAndRenameDocument,
  getCurrentDocumentId,
  getEditor,
  getTitleInput,
  grantClipboard,
  openWorkspace,
  setEditorText,
  waitForLocalSaved,
  waitForSyncOnline,
  watchPage,
} from './helpers/workspace';
import { expect, test } from './fixtures/backend';

test('shares a document into an independent collaborator context', async ({
  page,
  context,
  browser,
}) => {
  await grantClipboard(context);
  await openWorkspace(page);

  const documentId = await createAndRenameDocument(page, 'Shared From A');
  await setEditorText(page, 'HELLO');
  await waitForSyncOnline(page);

  await page.getByRole('button', { name: 'Share Link' }).click();
  await expect(page.getByText('Link copied')).toBeVisible();

  const sharedUrl = await page.evaluate(() => navigator.clipboard.readText());

  if (!sharedUrl) {
    throw new Error('Share Link did not copy a URL to the clipboard.');
  }
  expect(sharedUrl).toContain(`document=${documentId}`);
  expect(new URL(sharedUrl).searchParams.get('document')).toBe(documentId);

  const contextB = await browser.newContext();
  await grantClipboard(contextB);
  const pageB = await contextB.newPage();
  watchPage(pageB);

  try {
    await pageB.goto(sharedUrl);
    await expect(pageB).toHaveURL(new RegExp(`document=${documentId}(?:&|$)`));
    await expect.poll(() => getCurrentDocumentId(pageB)).toBe(documentId);
    await expect(getTitleInput(pageB)).toHaveValue('Untitled Document');
    await expect(getEditor(pageB)).toBeEnabled();
    await expect(getEditor(pageB)).toHaveValue('HELLO');
    await waitForLocalSaved(pageB);
    await waitForSyncOnline(pageB);
    await waitForSyncOnline(page);

    await setEditorText(page, 'HELLO-A');
    await waitForSyncOnline(page);
    await expect(getEditor(pageB)).toHaveValue('HELLO-A');
    await waitForLocalSaved(pageB);

    await setEditorText(pageB, 'HELLO-A-B');
    await waitForSyncOnline(pageB);
    await expect(getEditor(page)).toHaveValue('HELLO-A-B');
    await waitForLocalSaved(page);
    await waitForSyncOnline(page);

    await expect(getEditor(page)).toHaveValue('HELLO-A-B');
    await expect(getEditor(pageB)).toHaveValue('HELLO-A-B');
  } finally {
    await contextB.close();
  }
});

import {
  createAndRenameDocument,
  documentUrl,
  getEditor,
  getTitleInput,
  openWorkspace,
  setEditorText,
  waitForLocalSaved,
  waitForSyncDisconnected,
  waitForSyncOnline,
  watchPage,
} from './helpers/workspace';
import { expect, test } from './fixtures/backend';

test('keeps an inactive document outbox unflushed until that document is reopened', async ({
  page,
  browser,
  backend,
}) => {
  await openWorkspace(page);

  const sourceId = await createAndRenameDocument(page, 'Source A');
  await setEditorText(page, 'SOURCE');
  await waitForSyncOnline(page);

  await createAndRenameDocument(page, 'Target B');
  await setEditorText(page, 'TARGET');
  await waitForSyncOnline(page);

  await page.getByRole('button', { name: 'Source A', exact: true }).click();
  await expect(getEditor(page)).toBeEnabled();
  await expect(getTitleInput(page)).toHaveValue('Source A');
  await expect(getEditor(page)).toHaveValue('SOURCE');
  await waitForSyncOnline(page);

  await backend.stop();
  await waitForSyncDisconnected(page);

  await setEditorText(page, 'SOURCE[A-OFFLINE]');
  await waitForLocalSaved(page);

  await page.getByRole('button', { name: 'Target B', exact: true }).click();
  await expect(getEditor(page)).toBeEnabled();
  await expect(getTitleInput(page)).toHaveValue('Target B');
  await expect(getEditor(page)).toHaveValue('TARGET');
  await waitForLocalSaved(page);

  await backend.restart();
  await waitForSyncOnline(page);
  await expect(getEditor(page)).toHaveValue('TARGET');

  const contextC = await browser.newContext();
  const pageC = await contextC.newPage();
  watchPage(pageC);

  try {
    await pageC.goto(documentUrl(sourceId));
    await expect(getEditor(pageC)).toBeEnabled();
    await waitForLocalSaved(pageC);
    await waitForSyncOnline(pageC);
    await expect(getEditor(pageC)).toHaveValue('SOURCE');
    await expect(getEditor(pageC)).not.toHaveValue('SOURCE[A-OFFLINE]');

    await page.getByRole('button', { name: 'Source A', exact: true }).click();
    await expect(getEditor(page)).toBeEnabled();
    await expect(getTitleInput(page)).toHaveValue('Source A');
    await expect(getEditor(page)).toHaveValue('SOURCE[A-OFFLINE]');
    await waitForLocalSaved(page);
    await waitForSyncOnline(page);

    await expect(getEditor(pageC)).toHaveValue('SOURCE[A-OFFLINE]');
    await waitForLocalSaved(pageC);
    await waitForSyncOnline(pageC);
  } finally {
    await contextC.close();
  }
});

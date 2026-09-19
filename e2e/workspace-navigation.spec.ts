import { watchPage } from './helpers/workspace';
import {
  createAndRenameDocument,
  getCurrentDocumentId,
  getEditor,
  getTitleInput,
  openWorkspace,
  setEditorText,
  waitForLocalSaved,
  waitForSyncOnline,
} from './helpers/workspace';
import { expect, test } from './fixtures/backend';

test.describe('workspace navigation', () => {
  test('boots, creates documents, switches, and restores history', async ({ page }) => {
    await openWorkspace(page);

    expect(getCurrentDocumentId(page)).toBe('local-default-document');
    await expect(getTitleInput(page)).toHaveValue('Local Document');

    const alphaId = await createAndRenameDocument(page, 'E2E Alpha');
    await setEditorText(page, 'ALPHA');
    await waitForSyncOnline(page);

    const betaId = await createAndRenameDocument(page, 'E2E Beta');
    await setEditorText(page, 'BETA');
    await waitForSyncOnline(page);

    await page.getByRole('button', { name: 'E2E Alpha', exact: true }).click();
    await expect(getEditor(page)).toBeEnabled();
    await expect(getTitleInput(page)).toHaveValue('E2E Alpha');
    await expect(getEditor(page)).toHaveValue('ALPHA');
    await expect.poll(() => getCurrentDocumentId(page)).toBe(alphaId);
    await waitForLocalSaved(page);
    await waitForSyncOnline(page);

    await page.getByRole('button', { name: 'E2E Beta', exact: true }).click();
    await expect(getEditor(page)).toBeEnabled();
    await expect(getTitleInput(page)).toHaveValue('E2E Beta');
    await expect(getEditor(page)).toHaveValue('BETA');
    await expect.poll(() => getCurrentDocumentId(page)).toBe(betaId);

    await page.goBack();
    await expect(getEditor(page)).toBeEnabled();
    await expect.poll(() => getCurrentDocumentId(page)).toBe(alphaId);
    await expect(getTitleInput(page)).toHaveValue('E2E Alpha');
    await expect(getEditor(page)).toHaveValue('ALPHA');

    await page.goForward();
    await expect(getEditor(page)).toBeEnabled();
    await expect.poll(() => getCurrentDocumentId(page)).toBe(betaId);
    await expect(getTitleInput(page)).toHaveValue('E2E Beta');
    await expect(getEditor(page)).toHaveValue('BETA');

    await page.reload();
    await expect(getEditor(page)).toBeEnabled();
    await expect.poll(() => getCurrentDocumentId(page)).toBe(betaId);
    await expect(getTitleInput(page)).toHaveValue('E2E Beta');
    await expect(getEditor(page)).toHaveValue('BETA');
    await waitForLocalSaved(page);
    await waitForSyncOnline(page);
  });

  test('rejects an invalid document link and recovers into the workspace', async ({ page }) => {
    watchPage(page);
    await page.goto('/?document=not-a-valid-document-id');

    await expect(page.getByRole('heading', { name: 'Invalid document link' })).toBeVisible();
    await expect(getEditor(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Open Workspace' }).click();
    await expect(page).toHaveURL(/[?&]document=local-default-document(?:&|$)/);
    await expect(getEditor(page)).toBeEnabled();
    await waitForLocalSaved(page);
    await waitForSyncOnline(page);
  });
});

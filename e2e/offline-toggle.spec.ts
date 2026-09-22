import {
  createAndRenameDocument,
  documentUrl,
  getEditor,
  openWorkspace,
  setEditorText,
  waitForLocalSaved,
  waitForSyncDisconnected,
  waitForSyncOnline,
  watchPage,
} from './helpers/workspace';
import { expect, test } from './fixtures/backend';

/**
 * The product-level offline control must close the real socket, not merely
 * relabel the UI: edits taken while offline have to survive in the durable
 * outbox and converge on the server once the socket is restored.
 */
test('the offline control queues real edits and drains them on reconnect', async ({
  page,
  browser,
}) => {
  await openWorkspace(page);
  const documentId = await createAndRenameDocument(page, 'Toggle Doc');
  await setEditorText(page, 'ONLINE');
  await waitForSyncOnline(page);

  await page.getByRole('button', { name: 'Go Offline' }).click();
  await waitForSyncDisconnected(page);
  await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();

  await setEditorText(page, 'ONLINE-THEN-OFFLINE');
  await waitForLocalSaved(page);

  // Queued work is surfaced from the real outbox count.
  await expect(
    page.getByText(/changes safely queued locally|change safely queued locally/),
  ).toBeVisible();

  // Still offline: nothing has reached the server, so a fresh browser profile
  // must not see the offline text yet.
  const beforeContext = await browser.newContext();
  const beforePage = await beforeContext.newPage();
  watchPage(beforePage);

  try {
    await beforePage.goto(documentUrl(documentId));
    await expect(getEditor(beforePage)).toBeEnabled();
    await waitForSyncOnline(beforePage);
    await expect(getEditor(beforePage)).toHaveValue('ONLINE');
  } finally {
    await beforeContext.close();
  }

  await page.getByRole('button', { name: 'Reconnect' }).click();
  await waitForSyncOnline(page);
  await expect(getEditor(page)).toHaveValue('ONLINE-THEN-OFFLINE');
  await expect(page.getByRole('button', { name: 'Go Offline' })).toBeVisible();

  const afterContext = await browser.newContext();
  const afterPage = await afterContext.newPage();
  watchPage(afterPage);

  try {
    await afterPage.goto(documentUrl(documentId));
    await expect(getEditor(afterPage)).toBeEnabled();
    await waitForSyncOnline(afterPage);
    await expect(getEditor(afterPage)).toHaveValue('ONLINE-THEN-OFFLINE');
  } finally {
    await afterContext.close();
  }
});

test('offline edits survive a reload while the socket stays closed', async ({ page }) => {
  await openWorkspace(page);
  await createAndRenameDocument(page, 'Reload Doc');
  await setEditorText(page, 'KEEP');
  await waitForSyncOnline(page);

  await page.getByRole('button', { name: 'Go Offline' }).click();
  await waitForSyncDisconnected(page);
  await setEditorText(page, 'KEEP-OFFLINE');

  // Offline mode is a session control, so a reload reconnects; the durable
  // outbox is what carries the edit forward.
  await page.reload();
  await expect(getEditor(page)).toBeEnabled();
  await expect(getEditor(page)).toHaveValue('KEEP-OFFLINE');
  await waitForSyncOnline(page);
});

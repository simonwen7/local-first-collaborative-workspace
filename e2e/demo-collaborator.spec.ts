import {
  createAndRenameDocument,
  getEditor,
  openWorkspace,
  setEditorText,
  waitForSyncOnline,
} from './helpers/workspace';
import { expect, test } from './fixtures/backend';

/**
 * The demo collaborator is a genuinely separate replica: it opens its own
 * socket, joins with a distinct client id, and submits real CRDT operations
 * that the server sequences. The primary client must receive them through the
 * ordinary synchronization path.
 */
test('the demo collaborator converges real remote operations into this replica', async ({
  page,
}) => {
  await openWorkspace(page);
  await createAndRenameDocument(page, 'Collab Doc');
  await setEditorText(page, 'LOCAL');
  await waitForSyncOnline(page);

  await page.getByRole('button', { name: 'Launch Demo' }).click();

  // Tour controls are scoped to the guided-demo region so they never collide
  // with the equivalent toolbar actions.
  const tour = page.getByRole('region', { name: 'Guided demo' });
  await tour.getByRole('button', { name: 'Start the tour' }).click();

  // Advance through the tour using real state transitions only.
  await getEditor(page).fill('LOCAL EDIT');
  await getEditor(page).fill('LOCAL EDITS');
  await getEditor(page).fill('LOCAL EDITS!');
  await tour.getByRole('button', { name: 'Continue' }).click();

  await tour.getByRole('button', { name: 'Go offline' }).click();
  await getEditor(page).fill('LOCAL EDITS! OFFLINE');
  await tour.getByRole('button', { name: 'Continue' }).click();

  await tour.getByRole('button', { name: 'Reconnect' }).click();
  await waitForSyncOnline(page);
  await expect(tour.getByRole('button', { name: 'Add demo collaborator' })).toBeVisible({
    timeout: 10_000,
  });
  await tour.getByRole('button', { name: 'Add demo collaborator' }).click();

  // Presence is ephemeral room state published by the server.
  await expect(page.getByText('2 replicas online')).toBeVisible();

  // The remote text arrives as sequenced CRDT operations, not as a UI fake.
  await expect(getEditor(page)).toHaveValue(/A second replica joined and typed this/, {
    timeout: 20_000,
  });
  await expect(getEditor(page)).toHaveValue(/LOCAL EDITS! OFFLINE/);
  await waitForSyncOnline(page);
});

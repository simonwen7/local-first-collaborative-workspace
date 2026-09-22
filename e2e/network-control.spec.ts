import {
  createAndRenameDocument,
  getEditor,
  openWorkspace,
  setEditorText,
  topbarNetworkButton,
  waitForSyncDisconnected,
  waitForSyncOnline,
} from './helpers/workspace';
import { expect, test } from './fixtures/backend';

test('online state offers Go Offline and intentional offline offers Reconnect', async ({
  page,
}) => {
  await openWorkspace(page);
  await expect(page.getByText('Sync: Online', { exact: true })).toBeVisible();
  await expect(topbarNetworkButton(page)).toHaveText('Go Offline');

  await topbarNetworkButton(page).click();
  await waitForSyncDisconnected(page);
  await expect(page.getByText('Sync: Offline', { exact: true })).toBeVisible();
  await expect(topbarNetworkButton(page)).toHaveText('Reconnect');
  await expect(page.locator('.topbar').getByRole('button', { name: 'Go Offline' })).toHaveCount(0);

  await topbarNetworkButton(page).click();
  await waitForSyncOnline(page);
  await expect(topbarNetworkButton(page)).toHaveText('Go Offline');
});

test('unexpected server loss offers Retry Connection, never Go Offline', async ({
  page,
  backend,
}) => {
  await openWorkspace(page);
  await createAndRenameDocument(page, 'Drop Doc');
  await expect(topbarNetworkButton(page)).toHaveText('Go Offline');

  await backend.stop();

  await expect(page.locator('.topbar').getByRole('button', { name: 'Go Offline' })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(topbarNetworkButton(page)).toHaveText('Retry Connection', { timeout: 15_000 });
  await expect(page.getByText(/^Sync: (Disconnected|Unreachable|Reconnecting)$/)).toBeVisible();
});

test('tour step 3 reconnects through the real outbox and advances after convergence', async ({
  page,
}) => {
  await openWorkspace(page);
  await createAndRenameDocument(page, 'Tour Doc');
  await setEditorText(page, 'ONLINE');
  await waitForSyncOnline(page);

  await page.getByRole('button', { name: 'Launch Demo' }).click();
  const tour = page.getByRole('region', { name: 'Guided demo' });

  await tour.getByRole('button', { name: 'Start the tour' }).click();
  await getEditor(page).fill('ONLINE A');
  await getEditor(page).fill('ONLINE AB');
  await getEditor(page).fill('ONLINE ABC');
  await tour.getByRole('button', { name: 'Continue' }).click();

  await expect(tour.getByRole('button', { name: 'Go offline' })).toBeVisible();
  await tour.getByRole('button', { name: 'Go offline' }).click();
  await expect(page.getByText('Sync: Offline', { exact: true })).toBeVisible();
  await expect(topbarNetworkButton(page)).toHaveText('Reconnect');
  await expect(page.locator('.topbar').getByRole('button', { name: 'Go Offline' })).toHaveCount(0);

  await getEditor(page).fill('ONLINE ABC THEN OFFLINE');
  await tour.getByRole('button', { name: 'Continue' }).click();

  await expect(tour.getByRole('button', { name: 'Reconnect & Continue' })).toBeVisible();
  await expect(topbarNetworkButton(page)).toHaveText('Reconnect');
  await tour.getByRole('button', { name: 'Reconnect & Continue' }).click();

  await waitForSyncOnline(page);
  await expect(getEditor(page)).toHaveValue('ONLINE ABC THEN OFFLINE');
  await expect(tour.getByRole('heading', { name: 'Converged ✓' })).toBeVisible();

  await expect(tour.getByRole('button', { name: 'Add demo collaborator' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(topbarNetworkButton(page)).toHaveText('Go Offline');
});

test('tour step 3 surfaces a retry path when the sync server is gone', async ({
  page,
  backend,
}) => {
  await openWorkspace(page);
  await createAndRenameDocument(page, 'Unreachable Doc');
  await setEditorText(page, 'BASE');
  await waitForSyncOnline(page);

  await page.getByRole('button', { name: 'Launch Demo' }).click();
  const tour = page.getByRole('region', { name: 'Guided demo' });
  await tour.getByRole('button', { name: 'Start the tour' }).click();
  await getEditor(page).fill('BASE A');
  await getEditor(page).fill('BASE AB');
  await getEditor(page).fill('BASE ABC');
  await tour.getByRole('button', { name: 'Continue' }).click();
  await tour.getByRole('button', { name: 'Go offline' }).click();
  await getEditor(page).fill('BASE ABC OFFLINE');
  await tour.getByRole('button', { name: 'Continue' }).click();

  await backend.stop();
  await tour.getByRole('button', { name: 'Reconnect & Continue' }).click();

  await expect(tour.getByRole('heading', { name: 'Unable to reach the sync server' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(tour.getByRole('button', { name: 'Retry Connection' })).toBeVisible();
  await expect(page.locator('.topbar').getByRole('button', { name: 'Go Offline' })).toHaveCount(0);
  await expect(tour.getByRole('button', { name: 'Add demo collaborator' })).toHaveCount(0);

  await backend.start();
  await tour.getByRole('button', { name: 'Retry Connection' }).click();
  await waitForSyncOnline(page);
  await expect(tour.getByRole('button', { name: 'Add demo collaborator' })).toBeVisible({
    timeout: 10_000,
  });
});

import type { BrowserContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { E2E_WEB_ORIGIN } from '../fixtures/backend';

export function watchPage(page: Page): string[] {
  const lines: string[] = [];

  page.on('pageerror', (error) => {
    lines.push(`pageerror: ${error.stack ?? error.message}`);
  });

  page.on('console', (message) => {
    if (message.type() === 'error') {
      lines.push(`console.error: ${message.text()}`);
    }
  });

  return lines;
}

export async function openWorkspace(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await expect(page).toHaveURL(/[?&]document=local-default-document(?:&|$)/);
  await expect(getEditor(page)).toBeEnabled();
  await waitForLocalSaved(page);
  await waitForSyncOnline(page);
}

export function getEditor(page: Page) {
  return page.getByLabel('Document text');
}

export function getTitleInput(page: Page) {
  return page.getByLabel('Rename document');
}

export async function waitForLocalSaved(page: Page): Promise<void> {
  await expect(page.getByText('Local: Saved', { exact: true })).toBeVisible();
}

export async function waitForSyncOnline(page: Page): Promise<void> {
  await expect(page.getByText('Sync: Online', { exact: true })).toBeVisible();
}

export async function waitForSyncDisconnected(page: Page): Promise<void> {
  await expect(page.getByText('Sync: Online', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/^Sync: (Offline|Connecting|Error)$/)).toBeVisible();
}

export function getCurrentDocumentId(page: Page): string {
  const url = new URL(page.url());
  const documentId = url.searchParams.get('document');

  if (!documentId) {
    throw new Error(`Expected a document query parameter in ${page.url()}`);
  }

  return documentId;
}

export function documentUrl(documentId: string): string {
  return `${E2E_WEB_ORIGIN}/?document=${documentId}`;
}

export async function createAndRenameDocument(page: Page, title: string): Promise<string> {
  const previousId = getCurrentDocumentId(page);
  await page.getByRole('button', { name: 'New Document' }).click();
  await expect.poll(() => getCurrentDocumentId(page)).not.toBe(previousId);
  await expect(getEditor(page)).toBeEnabled();
  await expect(getTitleInput(page)).toHaveValue('Untitled Document');
  await waitForLocalSaved(page);
  await waitForSyncOnline(page);

  await getTitleInput(page).fill(title);
  await getTitleInput(page).press('Enter');
  await expect(getTitleInput(page)).toHaveValue(title);
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();

  return getCurrentDocumentId(page);
}

export async function setEditorText(page: Page, text: string): Promise<void> {
  await expect(getEditor(page)).toBeEnabled();
  await getEditor(page).fill(text);
  await expect(getEditor(page)).toHaveValue(text);
  await waitForLocalSaved(page);
}

export async function grantClipboard(context: BrowserContext): Promise<void> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: E2E_WEB_ORIGIN,
  });
}

import type { Page } from '@playwright/test';
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

test('holds the source session during composition until compositionend', async ({ page }) => {
  await openWorkspace(page);

  const sourceId = await createAndRenameDocument(page, 'Source A');
  await setEditorText(page, 'SOURCE-A');
  await waitForSyncOnline(page);

  const targetId = await createAndRenameDocument(page, 'Target B');
  await setEditorText(page, 'TARGET-B');
  await waitForSyncOnline(page);

  await page.getByRole('button', { name: 'Source A', exact: true }).click();
  await expect(getEditor(page)).toBeEnabled();
  await expect(getTitleInput(page)).toHaveValue('Source A');
  await expect(getEditor(page)).toHaveValue('SOURCE-A');
  await waitForSyncOnline(page);

  await getEditor(page).click();
  await startComposition(page, 'SOURCE-A你');

  await navigateByHistory(page, targetId);

  await expect(getEditor(page)).toBeEnabled();
  await expect(getTitleInput(page)).toHaveValue('Source A');
  await expect(getEditor(page)).toHaveValue('SOURCE-A你');
  await expect(getEditor(page)).not.toHaveValue('TARGET-B');

  await endComposition(page);

  await expect(getEditor(page)).toBeEnabled();
  await expect.poll(() => getCurrentDocumentId(page)).toBe(targetId);
  await expect(getTitleInput(page)).toHaveValue('Target B');
  await expect(getEditor(page)).toHaveValue('TARGET-B');
  expect(await getEditor(page).inputValue()).not.toContain('你');
  await waitForLocalSaved(page);
  await waitForSyncOnline(page);

  await page.getByRole('button', { name: 'Source A', exact: true }).click();
  await expect(getEditor(page)).toBeEnabled();
  await expect.poll(() => getCurrentDocumentId(page)).toBe(sourceId);
  await expect(getTitleInput(page)).toHaveValue('Source A');
  await expect(getEditor(page)).toHaveValue('SOURCE-A你');
  expect((await getEditor(page).inputValue()).split('你')).toHaveLength(2);
  await waitForLocalSaved(page);
  await waitForSyncOnline(page);
});

async function startComposition(page: Page, nextValue: string): Promise<void> {
  await page.evaluate((value) => {
    const textarea = document.getElementById('document-editor');

    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error('Expected the document editor textarea.');
    }

    textarea.focus();
    textarea.dispatchEvent(
      new CompositionEvent('compositionstart', {
        bubbles: true,
        cancelable: true,
        data: '',
      }),
    );

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: '你',
        inputType: 'insertCompositionText',
        isComposing: true,
      }),
    );
  }, nextValue);

  await expect(getEditor(page)).toHaveValue(nextValue);
}

async function endComposition(page: Page): Promise<void> {
  await page.evaluate(() => {
    const textarea = document.getElementById('document-editor');

    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error('Expected the document editor textarea.');
    }

    textarea.dispatchEvent(
      new CompositionEvent('compositionend', {
        bubbles: true,
        cancelable: true,
        data: '你',
      }),
    );
  });
}

async function navigateByHistory(page: Page, documentId: string): Promise<void> {
  await page.evaluate((targetId) => {
    const url = new URL(window.location.href);
    url.searchParams.set('document', targetId);
    window.history.pushState(
      { documentId: targetId },
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, documentId);
}

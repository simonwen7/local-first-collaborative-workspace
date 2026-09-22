import {
  createAndRenameDocument,
  documentUrl,
  getEditor,
  openWorkspace,
  setEditorText,
  waitForLocalSaved,
  waitForSyncOnline,
  watchPage,
} from './helpers/workspace';
import { expect, test } from './fixtures/backend';

/**
 * Remote operations replace the materialized text of the local textarea. The
 * caret is anchored to CRDT element identities so it stays at the same logical
 * position instead of being dragged by edits that happened elsewhere.
 */
test('keeps the caret anchored when a remote replica edits elsewhere', async ({
  page,
  browser,
}) => {
  await openWorkspace(page);
  const documentId = await createAndRenameDocument(page, 'Caret Doc');
  await setEditorText(page, 'HELLO');
  await waitForSyncOnline(page);

  const context = await browser.newContext();
  const remote = await context.newPage();
  watchPage(remote);

  try {
    await remote.goto(documentUrl(documentId));
    await expect(getEditor(remote)).toBeEnabled();
    await expect(getEditor(remote)).toHaveValue('HELLO');
    await waitForSyncOnline(remote);

    // Park the local caret at the very start of the document.
    await getEditor(page).click();
    await getEditor(page).evaluate((node: HTMLTextAreaElement) => {
      node.setSelectionRange(0, 0);
    });
    await expect
      .poll(() => getEditor(page).evaluate((node: HTMLTextAreaElement) => node.selectionStart))
      .toBe(0);

    // The remote replica appends after the caret.
    await getEditor(remote).fill('HELLO WORLD');
    await expect(getEditor(page)).toHaveValue('HELLO WORLD');

    // The caret must still be at offset 0, so typing prepends.
    await expect
      .poll(() => getEditor(page).evaluate((node: HTMLTextAreaElement) => node.selectionStart))
      .toBe(0);

    await getEditor(page).type('X');
    await expect(getEditor(page)).toHaveValue('XHELLO WORLD');
    await waitForLocalSaved(page);
  } finally {
    await context.close();
  }
});

test('does not scramble continuous typing while server echoes arrive', async ({ page }) => {
  await openWorkspace(page);
  await createAndRenameDocument(page, 'Typing Doc');
  await setEditorText(page, 'START.');
  await waitForSyncOnline(page);

  // Each keystroke round-trips through the server as a sender echo while the
  // next keystroke is already being typed.
  await getEditor(page).click();
  await getEditor(page).evaluate((node: HTMLTextAreaElement) => {
    node.setSelectionRange(node.value.length, node.value.length);
  });
  await getEditor(page).type(' Converged.', { delay: 35 });

  await expect(getEditor(page)).toHaveValue('START. Converged.');
  await waitForSyncOnline(page);
  await expect(getEditor(page)).toHaveValue('START. Converged.');
});

test('keeps mid-document typing in order across sender echoes', async ({ page }) => {
  await openWorkspace(page);
  await createAndRenameDocument(page, 'Middle Doc');
  await setEditorText(page, 'HEAD||TAIL');
  await waitForSyncOnline(page);

  // Park the caret between the pipes and type a run of characters. Any caret
  // drift shows up as reordered or displaced text rather than a clean insert.
  await getEditor(page).click();
  await getEditor(page).evaluate((node: HTMLTextAreaElement) => {
    const caret = node.value.indexOf('||') + 1;
    node.setSelectionRange(caret, caret);
  });
  await getEditor(page).type('MIDDLE', { delay: 35 });

  await expect(getEditor(page)).toHaveValue('HEAD|MIDDLE|TAIL');
  await waitForSyncOnline(page);
  await expect(getEditor(page)).toHaveValue('HEAD|MIDDLE|TAIL');
});

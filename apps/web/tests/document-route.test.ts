import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCUMENT_ID } from '../src/persistence/local-document-store';
import {
  buildDocumentUrl,
  isValidWorkspaceDocumentId,
  readDocumentIdFromSearch,
} from '../src/workspace/document-route';

describe('document-route', () => {
  it('distinguishes a missing query from a valid or invalid route', () => {
    expect(readDocumentIdFromSearch('')).toEqual({ status: 'missing' });
    expect(readDocumentIdFromSearch('?other=1')).toEqual({ status: 'missing' });
    expect(readDocumentIdFromSearch(`?document=${DEFAULT_DOCUMENT_ID}`)).toEqual({
      status: 'valid',
      documentId: DEFAULT_DOCUMENT_ID,
    });
    expect(readDocumentIdFromSearch('?document=')).toEqual({ status: 'invalid', raw: '' });
  });

  it('accepts a canonical UUID and the legacy default id', () => {
    const generated = crypto.randomUUID();
    expect(isValidWorkspaceDocumentId(generated)).toBe(true);
    expect(isValidWorkspaceDocumentId(DEFAULT_DOCUMENT_ID)).toBe(true);
    expect(readDocumentIdFromSearch(`?document=${generated}`)).toEqual({
      status: 'valid',
      documentId: generated,
    });
  });

  it('rejects empty, malformed, and overly long ids', () => {
    expect(isValidWorkspaceDocumentId('')).toBe(false);
    expect(isValidWorkspaceDocumentId('not-a-document')).toBe(false);
    expect(isValidWorkspaceDocumentId('x'.repeat(80))).toBe(false);
    expect(readDocumentIdFromSearch('?document=not-a-document')).toEqual({
      status: 'invalid',
      raw: 'not-a-document',
    });
  });

  it('writes the document param and preserves unrelated query params', () => {
    const generated = crypto.randomUUID();
    expect(buildDocumentUrl(generated, 'https://example.test/app?tab=edit#top')).toBe(
      `/app?tab=edit&document=${generated}#top`,
    );
    expect(buildDocumentUrl(DEFAULT_DOCUMENT_ID, '/?other=keep')).toBe(
      `/?other=keep&document=${DEFAULT_DOCUMENT_ID}`,
    );
  });
});

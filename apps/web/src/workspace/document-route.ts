import { DEFAULT_DOCUMENT_ID } from '../persistence/local-document-store';

export const DOCUMENT_QUERY_PARAM = 'document';
export const MAX_ROUTE_DOCUMENT_ID_LENGTH = 64;

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DocumentRouteRead =
  | { readonly status: 'missing' }
  | { readonly status: 'valid'; readonly documentId: string }
  | { readonly status: 'invalid'; readonly raw: string };

export function isValidWorkspaceDocumentId(id: string): boolean {
  if (id === DEFAULT_DOCUMENT_ID) {
    return true;
  }

  if (id.length === 0 || id.length > MAX_ROUTE_DOCUMENT_ID_LENGTH) {
    return false;
  }

  return CANONICAL_UUID_PATTERN.test(id);
}

export function readDocumentIdFromSearch(search: string): DocumentRouteRead {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);

  if (!params.has(DOCUMENT_QUERY_PARAM)) {
    return { status: 'missing' };
  }

  const raw = params.get(DOCUMENT_QUERY_PARAM) ?? '';

  if (!isValidWorkspaceDocumentId(raw)) {
    return { status: 'invalid', raw };
  }

  return { status: 'valid', documentId: raw };
}

export function buildDocumentUrl(documentId: string, currentUrl: string): string {
  const url = new URL(currentUrl, 'http://127.0.0.1');
  url.searchParams.set(DOCUMENT_QUERY_PARAM, documentId);
  return `${url.pathname}${url.search}${url.hash}`;
}

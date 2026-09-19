import type { DocumentRecord } from './database';
import { LocalWorkspaceDatabase } from './database';
import { DEFAULT_DOCUMENT_ID, DEFAULT_DOCUMENT_TITLE } from './local-document-store';

export const UNTITLED_DOCUMENT_TITLE = 'Untitled Document';
export const MAX_DOCUMENT_TITLE_CODE_POINTS = 80;

export class InvalidDocumentTitleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDocumentTitleError';
  }
}

export interface LocalWorkspaceCatalogOptions {
  readonly databaseName?: string;
  readonly now?: () => string;
}

export class LocalWorkspaceCatalog {
  private readonly now: () => string;
  readonly database: LocalWorkspaceDatabase;

  constructor(options: LocalWorkspaceCatalogOptions = {}) {
    this.database = new LocalWorkspaceDatabase(options.databaseName);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async ensureDocument(
    documentId: string,
    defaultTitle: string = defaultTitleFor(documentId),
  ): Promise<DocumentRecord> {
    return this.database.transaction(
      'rw',
      this.database.documents,
      this.database.syncState,
      async () => {
        const existing = await this.database.documents.get(documentId);

        if (existing) {
          await this.ensureSyncState(documentId);
          return existing;
        }

        const timestamp = this.now();
        const record: DocumentRecord = {
          id: documentId,
          title: normalizeDocumentTitle(defaultTitle),
          createdAt: timestamp,
          updatedAt: timestamp,
        };

        await this.database.documents.add(record);
        await this.ensureSyncState(documentId);
        return record;
      },
    );
  }

  async createDocument(documentId: string, title: string): Promise<DocumentRecord> {
    return this.ensureDocument(documentId, title);
  }

  async listDocuments(): Promise<DocumentRecord[]> {
    const documents = await this.database.documents.toArray();

    return documents.sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt < right.createdAt ? -1 : 1;
      }

      if (left.id === right.id) {
        return 0;
      }

      return left.id < right.id ? -1 : 1;
    });
  }

  async renameDocument(documentId: string, title: string): Promise<DocumentRecord> {
    const normalized = normalizeDocumentTitle(title);

    return this.database.transaction('rw', this.database.documents, async () => {
      const existing = await this.database.documents.get(documentId);

      if (!existing) {
        throw new Error(`Document "${documentId}" does not exist.`);
      }

      const next: DocumentRecord = {
        ...existing,
        title: normalized,
        updatedAt: this.now(),
      };

      await this.database.documents.put(next);
      return next;
    });
  }

  close(): void {
    this.database.close();
  }

  private async ensureSyncState(documentId: string): Promise<void> {
    const syncState = await this.database.syncState.get(documentId);

    if (!syncState) {
      await this.database.syncState.add({
        documentId,
        lastServerSeq: 0,
      });
    }
  }
}

export function defaultTitleFor(documentId: string): string {
  return documentId === DEFAULT_DOCUMENT_ID ? DEFAULT_DOCUMENT_TITLE : UNTITLED_DOCUMENT_TITLE;
}

export function normalizeDocumentTitle(title: string): string {
  const trimmed = title.trim();

  if (trimmed.length === 0) {
    throw new InvalidDocumentTitleError('Document title must not be empty.');
  }

  if (Array.from(trimmed).length > MAX_DOCUMENT_TITLE_CODE_POINTS) {
    throw new InvalidDocumentTitleError(
      `Document title must be at most ${MAX_DOCUMENT_TITLE_CODE_POINTS} characters.`,
    );
  }

  return trimmed;
}

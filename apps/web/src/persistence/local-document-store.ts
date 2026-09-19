import { createDeleteOperation, createInsertOperation } from '@lfcw/crdt';
import type { TextOperation } from '@lfcw/crdt';
import type { LocalTextEdit } from '../editor/text-edit';
import { CLIENT_META_KEY, LocalWorkspaceDatabase } from './database';
import type { ClientMetaRecord, DocumentRecord, OperationRecord } from './database';

export const DEFAULT_DOCUMENT_ID = 'local-default-document';

const DEFAULT_DOCUMENT_TITLE = 'Local Document';

export interface LocalDocumentStoreOptions {
  readonly clientIdFactory?: () => string;
  readonly now?: () => string;
}

export interface InitializedLocalDocument {
  readonly clientMeta: ClientMetaRecord;
  readonly document: DocumentRecord;
}

export class LocalDocumentStore {
  private readonly clientIdFactory: () => string;
  private readonly now: () => string;

  constructor(
    readonly database: LocalWorkspaceDatabase,
    options: LocalDocumentStoreOptions = {},
  ) {
    this.clientIdFactory =
      options.clientIdFactory ??
      (() => {
        if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
          throw new Error(
            'crypto.randomUUID is required to create a stable local client identity.',
          );
        }

        return crypto.randomUUID();
      });

    this.now = options.now ?? (() => new Date().toISOString());
  }

  async initialize(): Promise<InitializedLocalDocument> {
    return this.database.transaction(
      'rw',
      this.database.clientMeta,
      this.database.documents,
      async () => {
        let clientMeta = await this.database.clientMeta.get(CLIENT_META_KEY);

        if (!clientMeta) {
          clientMeta = {
            key: CLIENT_META_KEY,
            clientId: this.clientIdFactory(),
            nextCounter: 1,
            lamportClock: 0,
          };

          await this.database.clientMeta.add(clientMeta);
        }

        let document = await this.database.documents.get(DEFAULT_DOCUMENT_ID);

        if (!document) {
          const timestamp = this.now();

          document = {
            id: DEFAULT_DOCUMENT_ID,
            title: DEFAULT_DOCUMENT_TITLE,
            createdAt: timestamp,
            updatedAt: timestamp,
          };

          await this.database.documents.add(document);
        }

        return {
          clientMeta,
          document,
        };
      },
    );
  }

  async loadOperations(documentId: string): Promise<TextOperation[]> {
    const records = await this.database.operations.where('documentId').equals(documentId).toArray();

    return records.map((record) => record.operation);
  }

  async persistLocalTextEdit(documentId: string, edit: LocalTextEdit): Promise<TextOperation[]> {
    if (edit.deleteTargetIds.length === 0 && edit.insertValues.length === 0) {
      return [];
    }

    return this.database.transaction(
      'rw',
      this.database.clientMeta,
      this.database.documents,
      this.database.operations,
      async () => {
        const clientMeta = await this.database.clientMeta.get(CLIENT_META_KEY);

        if (!clientMeta) {
          throw new Error('Local client metadata is missing.');
        }

        const document = await this.database.documents.get(documentId);

        if (!document) {
          throw new Error(`Document "${documentId}" does not exist.`);
        }

        let nextCounter = clientMeta.nextCounter;
        let lamportClock = clientMeta.lamportClock;
        const operations: TextOperation[] = [];

        const allocateIdentity = () => {
          const counter = nextCounter;
          nextCounter += 1;
          lamportClock += 1;

          return {
            counter,
            lamport: lamportClock,
          };
        };

        for (const targetId of edit.deleteTargetIds) {
          const identity = allocateIdentity();

          operations.push(
            createDeleteOperation({
              clientId: clientMeta.clientId,
              counter: identity.counter,
              lamport: identity.lamport,
              targetId,
            }),
          );
        }

        let insertAnchor = edit.insertAfterId;

        for (const value of edit.insertValues) {
          const identity = allocateIdentity();

          const operation = createInsertOperation({
            clientId: clientMeta.clientId,
            counter: identity.counter,
            lamport: identity.lamport,
            afterId: insertAnchor,
            value,
          });

          operations.push(operation);
          insertAnchor = operation.opId;
        }

        const timestamp = this.now();

        const operationRecords: OperationRecord[] = operations.map((operation) => ({
          opId: operation.opId,
          documentId,
          operation,
          createdAt: timestamp,
        }));

        await this.database.operations.bulkAdd(operationRecords);

        await this.database.clientMeta.put({
          ...clientMeta,
          nextCounter,
          lamportClock,
        });

        await this.database.documents.put({
          ...document,
          updatedAt: timestamp,
        });

        return operations;
      },
    );
  }

  async readClientMeta(): Promise<ClientMetaRecord> {
    const clientMeta = await this.database.clientMeta.get(CLIENT_META_KEY);

    if (!clientMeta) {
      throw new Error('Local client metadata is missing.');
    }

    return clientMeta;
  }

  close(): void {
    this.database.close();
  }
}

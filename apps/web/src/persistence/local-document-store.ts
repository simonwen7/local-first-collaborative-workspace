import {
  OperationIdentityConflictError,
  createDeleteOperation,
  createInsertOperation,
  operationsEqual,
  validateOperation,
} from '@lfcw/crdt';
import type { TextOperation, TextReplicaSnapshot } from '@lfcw/crdt';
import type { SequencedOperation } from '@lfcw/protocol';
import type { LocalTextEdit } from '../editor/text-edit';
import { CLIENT_META_KEY, LocalWorkspaceDatabase } from './database';
import type {
  ClientMetaRecord,
  DocumentRecord,
  OperationRecord,
  OutboxRecord,
  ReplicaSnapshotRecord,
} from './database';

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

export class InvalidServerBatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidServerBatchError';
  }
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
      this.database.syncState,
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

        const syncState = await this.database.syncState.get(document.id);

        if (!syncState) {
          await this.database.syncState.add({
            documentId: document.id,
            lastServerSeq: 0,
          });
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

  async loadPendingOperations(documentId: string): Promise<TextOperation[]> {
    const markers = await this.database.outbox.where('documentId').equals(documentId).toArray();
    const operations: TextOperation[] = [];

    for (const marker of markers) {
      const record = await this.database.operations.get(marker.opId);

      if (!record) {
        throw new Error(
          `Outbox marker "${marker.opId}" is missing its canonical operation record.`,
        );
      }

      operations.push(record.operation);
    }

    return operations.sort((left, right) => left.counter - right.counter);
  }

  async getLastServerSeq(documentId: string): Promise<number> {
    const syncState = await this.database.syncState.get(documentId);
    return syncState?.lastServerSeq ?? 0;
  }

  async loadReplicaSnapshot(documentId: string): Promise<ReplicaSnapshotRecord | undefined> {
    return this.database.replicaSnapshots.get(documentId);
  }

  async saveReplicaSnapshot(
    documentId: string,
    snapshot: TextReplicaSnapshot,
    knownOperationCount: number,
  ): Promise<void> {
    const record: ReplicaSnapshotRecord = {
      documentId,
      snapshot,
      knownOperationCount,
      createdAt: this.now(),
    };

    await this.database.replicaSnapshots.put(record);
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
      this.database.outbox,
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
        const outboxCreatedAt = Date.now();

        const operationRecords: OperationRecord[] = operations.map((operation) => ({
          opId: operation.opId,
          documentId,
          operation,
          createdAt: timestamp,
        }));

        const outboxRecords: OutboxRecord[] = operations.map((operation) => ({
          opId: operation.opId,
          documentId,
          createdAt: outboxCreatedAt,
        }));

        await this.database.operations.bulkAdd(operationRecords);
        await this.database.outbox.bulkAdd(outboxRecords);

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

  async persistServerOperations(
    documentId: string,
    sequencedOperations: readonly SequencedOperation[],
    confirmedThroughServerSeq: number,
  ): Promise<void> {
    validateServerBatch(sequencedOperations, confirmedThroughServerSeq);

    await this.database.transaction(
      'rw',
      this.database.clientMeta,
      this.database.documents,
      this.database.operations,
      this.database.outbox,
      this.database.syncState,
      async () => {
        const clientMeta = await this.database.clientMeta.get(CLIENT_META_KEY);

        if (!clientMeta) {
          throw new Error('Local client metadata is missing.');
        }

        const document = await this.database.documents.get(documentId);

        if (!document) {
          throw new Error(`Document "${documentId}" does not exist.`);
        }

        let lamportClock = clientMeta.lamportClock;
        let insertedAny = false;
        const timestamp = this.now();

        for (const item of sequencedOperations) {
          const operation = item.operation;
          validateOperation(operation);
          lamportClock = Math.max(lamportClock, operation.lamport);

          const existing = await this.database.operations.get(operation.opId);

          if (!existing) {
            const record: OperationRecord = {
              opId: operation.opId,
              documentId,
              operation,
              createdAt: timestamp,
            };

            await this.database.operations.add(record);
            insertedAny = true;
          } else if (!operationsEqual(existing.operation, operation)) {
            throw new OperationIdentityConflictError(operation.opId);
          }

          const outboxRow = await this.database.outbox.get(operation.opId);

          if (outboxRow) {
            const canonical = existing ?? { operation };

            if (!operationsEqual(canonical.operation, operation)) {
              throw new OperationIdentityConflictError(operation.opId);
            }

            await this.database.outbox.delete(operation.opId);
          }
        }

        if (lamportClock !== clientMeta.lamportClock) {
          await this.database.clientMeta.put({
            ...clientMeta,
            lamportClock,
          });
        }

        if (insertedAny) {
          await this.database.documents.put({
            ...document,
            updatedAt: timestamp,
          });
        }

        const syncState = await this.database.syncState.get(documentId);
        const currentLastServerSeq = syncState?.lastServerSeq ?? 0;
        const nextLastServerSeq = Math.max(currentLastServerSeq, confirmedThroughServerSeq);

        await this.database.syncState.put({
          documentId,
          lastServerSeq: nextLastServerSeq,
        });
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

export function validateServerBatch(
  sequencedOperations: readonly SequencedOperation[],
  confirmedThroughServerSeq: number,
): void {
  if (!Number.isSafeInteger(confirmedThroughServerSeq) || confirmedThroughServerSeq < 0) {
    throw new InvalidServerBatchError(
      'confirmedThroughServerSeq must be a non-negative safe integer.',
    );
  }

  let previousServerSeq = 0;

  for (const item of sequencedOperations) {
    if (!Number.isSafeInteger(item.serverSeq) || item.serverSeq < 1) {
      throw new InvalidServerBatchError('serverSeq must be a positive safe integer.');
    }

    if (item.serverSeq <= previousServerSeq) {
      throw new InvalidServerBatchError('serverSeq values must be strictly increasing.');
    }

    if (item.serverSeq > confirmedThroughServerSeq) {
      throw new InvalidServerBatchError('serverSeq must not exceed confirmedThroughServerSeq.');
    }

    previousServerSeq = item.serverSeq;
  }
}

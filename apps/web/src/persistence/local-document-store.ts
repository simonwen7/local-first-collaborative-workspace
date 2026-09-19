import {
  OperationIdentityConflictError,
  TextReplica,
  createDeleteOperation,
  createInsertOperation,
  operationsEqual,
  validateOperation,
} from '@lfcw/crdt';
import type { TextOperation, TextReplicaSnapshot } from '@lfcw/crdt';
import type { SequencedOperation, SnapshotBootstrap } from '@lfcw/protocol';
import type { LocalTextEdit } from '../editor/text-edit';
import { CLIENT_META_KEY, LocalWorkspaceDatabase } from './database';
import type {
  ClientMetaRecord,
  DocumentRecord,
  OperationRecord,
  OutboxRecord,
  ReplicaSnapshotRecord,
  ServerBaselineRecord,
} from './database';

export const DEFAULT_DOCUMENT_ID = 'local-default-document';

export const DEFAULT_DOCUMENT_TITLE = 'Local Document';

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

export class SnapshotBootstrapIneligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotBootstrapIneligibleError';
  }
}

export class InvalidSnapshotBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSnapshotBootstrapError';
  }
}

export class InvalidServerBaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidServerBaselineError';
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

  async initialize(
    documentId: string = DEFAULT_DOCUMENT_ID,
    defaultTitle: string = documentId === DEFAULT_DOCUMENT_ID
      ? DEFAULT_DOCUMENT_TITLE
      : 'Untitled Document',
  ): Promise<InitializedLocalDocument> {
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

        let document = await this.database.documents.get(documentId);

        if (!document) {
          const timestamp = this.now();

          document = {
            id: documentId,
            title: defaultTitle,
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

      if (record.documentId !== documentId || marker.documentId !== documentId) {
        throw new OperationIdentityConflictError(marker.opId);
      }

      operations.push(record.operation);
    }

    return operations.sort((left, right) => left.counter - right.counter);
  }

  async getLastServerSeq(documentId: string): Promise<number> {
    const syncState = await this.database.syncState.get(documentId);
    return syncState?.lastServerSeq ?? 0;
  }

  async loadServerBaseline(documentId: string): Promise<ServerBaselineRecord | undefined> {
    return this.database.serverBaselines.get(documentId);
  }

  async isSnapshotBootstrapEligible(documentId: string): Promise<boolean> {
    const lastServerSeq = await this.getLastServerSeq(documentId);
    const baseline = await this.loadServerBaseline(documentId);
    const operationCount = await this.database.operations
      .where('documentId')
      .equals(documentId)
      .count();
    const outboxCount = await this.database.outbox.where('documentId').equals(documentId).count();

    return lastServerSeq === 0 && !baseline && operationCount === 0 && outboxCount === 0;
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

  async installServerBaseline(
    documentId: string,
    bootstrap: SnapshotBootstrap,
    sequencedOperations: readonly SequencedOperation[],
    confirmedThroughServerSeq: number,
  ): Promise<TextReplica> {
    const snapshot = parseBootstrapSnapshot(bootstrap);
    validateSnapshotSuffix(sequencedOperations, bootstrap.snapshotSeq, confirmedThroughServerSeq);

    let replica: TextReplica;

    try {
      replica = TextReplica.fromSnapshot(snapshot);
      replica.applyAll(sequencedOperations.map((item) => item.operation));
    } catch (error) {
      if (error instanceof InvalidSnapshotBootstrapError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : 'Invalid snapshot bootstrap.';
      throw new InvalidSnapshotBootstrapError(message);
    }

    if (replica.getUnresolvedOperationIds().length > 0) {
      throw new InvalidSnapshotBootstrapError(
        `Snapshot bootstrap left unresolved dependencies: ${replica.getUnresolvedOperationIds().join(', ')}`,
      );
    }

    const prefixLamport = maxLamportFromSnapshot(snapshot);
    const suffixLamport = sequencedOperations.reduce(
      (max, item) => Math.max(max, item.operation.lamport),
      0,
    );
    const historicalLamport = Math.max(prefixLamport, suffixLamport);

    await this.database.transaction(
      'rw',
      [
        this.database.clientMeta,
        this.database.documents,
        this.database.operations,
        this.database.outbox,
        this.database.syncState,
        this.database.serverBaselines,
        this.database.replicaSnapshots,
      ],
      async () => {
        const eligible = await this.isSnapshotBootstrapEligible(documentId);

        if (!eligible) {
          throw new SnapshotBootstrapIneligibleError(
            `Document "${documentId}" is no longer eligible for snapshot bootstrap.`,
          );
        }

        const clientMeta = await this.database.clientMeta.get(CLIENT_META_KEY);

        if (!clientMeta) {
          throw new Error('Local client metadata is missing.');
        }

        const document = await this.database.documents.get(documentId);

        if (!document) {
          throw new Error(`Document "${documentId}" does not exist.`);
        }

        const timestamp = this.now();
        const operationRecords: OperationRecord[] = sequencedOperations.map((item) => ({
          opId: item.operation.opId,
          documentId,
          operation: item.operation,
          createdAt: timestamp,
        }));

        if (operationRecords.length > 0) {
          await this.database.operations.bulkAdd(operationRecords);
        }

        await this.database.serverBaselines.put({
          documentId,
          snapshotSeq: bootstrap.snapshotSeq,
          snapshot,
          createdAt: timestamp,
        });

        await this.database.syncState.put({
          documentId,
          lastServerSeq: confirmedThroughServerSeq,
        });

        await this.database.clientMeta.put({
          ...clientMeta,
          lamportClock: Math.max(clientMeta.lamportClock, historicalLamport),
        });

        await this.database.documents.put({
          ...document,
          updatedAt: timestamp,
        });

        await this.database.replicaSnapshots.delete(documentId);
      },
    );

    return replica;
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

          if (existing && existing.documentId !== documentId) {
            throw new OperationIdentityConflictError(operation.opId);
          }

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
            if (outboxRow.documentId !== documentId) {
              throw new OperationIdentityConflictError(operation.opId);
            }

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

export function validateSnapshotSuffix(
  sequencedOperations: readonly SequencedOperation[],
  snapshotSeq: number,
  confirmedThroughServerSeq: number,
): void {
  if (!Number.isSafeInteger(snapshotSeq) || snapshotSeq < 1) {
    throw new InvalidSnapshotBootstrapError('snapshotSeq must be a positive safe integer.');
  }

  if (snapshotSeq > confirmedThroughServerSeq) {
    throw new InvalidSnapshotBootstrapError('snapshotSeq must not exceed latestServerSeq.');
  }

  try {
    validateServerBatch(sequencedOperations, confirmedThroughServerSeq);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid snapshot suffix.';
    throw new InvalidSnapshotBootstrapError(message);
  }

  for (const item of sequencedOperations) {
    if (item.serverSeq <= snapshotSeq) {
      throw new InvalidSnapshotBootstrapError(
        'Snapshot suffix serverSeq values must be greater than snapshotSeq.',
      );
    }
  }
}

export function maxLamportFromSnapshot(snapshot: TextReplicaSnapshot): number {
  let max = 0;

  for (const node of snapshot.nodes) {
    max = Math.max(max, node.lamport);
  }

  for (const operation of snapshot.deleteOperations) {
    max = Math.max(max, operation.lamport);
  }

  return max;
}

function parseBootstrapSnapshot(bootstrap: SnapshotBootstrap): TextReplicaSnapshot {
  if (bootstrap.version !== 1) {
    throw new InvalidSnapshotBootstrapError(
      `Unsupported snapshot bootstrap version "${String(bootstrap.version)}".`,
    );
  }

  return bootstrap.snapshot as TextReplicaSnapshot;
}

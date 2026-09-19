import Dexie, { type Table, type Transaction } from 'dexie';
import type { TextOperation, TextReplicaSnapshot } from '@lfcw/crdt';

export const CLIENT_META_KEY = 'local-replica' as const;

export interface ClientMetaRecord {
  readonly key: typeof CLIENT_META_KEY;
  readonly clientId: string;
  readonly nextCounter: number;
  readonly lamportClock: number;
}

export interface DocumentRecord {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OperationRecord {
  readonly opId: string;
  readonly documentId: string;
  readonly operation: TextOperation;
  readonly createdAt: string;
}

export interface OutboxRecord {
  readonly opId: string;
  readonly documentId: string;
  readonly createdAt: number;
}

export interface SyncStateRecord {
  readonly documentId: string;
  readonly lastServerSeq: number;
}

export interface ReplicaSnapshotRecord {
  readonly documentId: string;
  readonly snapshot: TextReplicaSnapshot;
  readonly knownOperationCount: number;
  readonly createdAt: string;
}

export class LocalWorkspaceDatabase extends Dexie {
  readonly clientMeta!: Table<ClientMetaRecord, string>;
  readonly documents!: Table<DocumentRecord, string>;
  readonly operations!: Table<OperationRecord, string>;
  readonly outbox!: Table<OutboxRecord, string>;
  readonly syncState!: Table<SyncStateRecord, string>;
  readonly replicaSnapshots!: Table<ReplicaSnapshotRecord, string>;

  constructor(databaseName = 'lfcw-local-workspace') {
    super(databaseName);

    this.version(1).stores({
      clientMeta: '&key',
      documents: '&id, updatedAt',
      operations: '&opId, documentId, createdAt',
    });

    this.version(2)
      .stores({
        clientMeta: '&key',
        documents: '&id, updatedAt',
        operations: '&opId, documentId, createdAt',
        outbox: '&opId, documentId, createdAt',
        syncState: '&documentId',
      })
      .upgrade(async (transaction: Transaction) => {
        await migrateV1ToV2(transaction);
      });

    this.version(3).stores({
      clientMeta: '&key',
      documents: '&id, updatedAt',
      operations: '&opId, documentId, createdAt',
      outbox: '&opId, documentId, createdAt',
      syncState: '&documentId',
      replicaSnapshots: '&documentId, createdAt',
    });
  }
}

export async function migrateV1ToV2(transaction: Transaction): Promise<void> {
  const documents = transaction.table('documents');
  const operations = transaction.table('operations');
  const clientMeta = transaction.table('clientMeta');
  const outbox = transaction.table('outbox');
  const syncState = transaction.table('syncState');

  const documentRecords = (await documents.toArray()) as DocumentRecord[];

  for (const document of documentRecords) {
    await syncState.put({
      documentId: document.id,
      lastServerSeq: 0,
    });
  }

  const meta = (await clientMeta.get(CLIENT_META_KEY)) as ClientMetaRecord | undefined;

  if (!meta) {
    return;
  }

  const operationRecords = (await operations.toArray()) as OperationRecord[];
  const migratedAt = Date.now();

  for (const record of operationRecords) {
    if (record.operation.clientId !== meta.clientId) {
      continue;
    }

    await outbox.put({
      opId: record.opId,
      documentId: record.documentId,
      createdAt: migratedAt,
    });
  }
}

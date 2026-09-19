import Dexie, { type Table } from 'dexie';
import type { TextOperation } from '@lfcw/crdt';

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

export class LocalWorkspaceDatabase extends Dexie {
  readonly clientMeta!: Table<ClientMetaRecord, string>;
  readonly documents!: Table<DocumentRecord, string>;
  readonly operations!: Table<OperationRecord, string>;

  constructor(databaseName = 'lfcw-local-workspace') {
    super(databaseName);

    this.version(1).stores({
      clientMeta: '&key',
      documents: '&id, updatedAt',
      operations: '&opId, documentId, createdAt',
    });
  }
}

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { OperationIdentityConflictError, operationsEqual, validateOperation } from '@lfcw/crdt';
import type { TextOperation } from '@lfcw/crdt';

export const DEFAULT_DATABASE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../data/lfcw.sqlite',
);

export const SERVER_SCHEMA_VERSION = 2;

export class IncompatibleServerSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompatibleServerSchemaError';
  }
}

export interface SequencedPersistedOperation {
  readonly serverSeq: number;
  readonly operation: TextOperation;
}

export interface AppendOperationResult {
  readonly serverSeq: number;
  readonly inserted: boolean;
}

export interface ServerSnapshotRow {
  readonly documentId: string;
  readonly snapshotSeq: number;
  readonly snapshotVersion: number;
  readonly snapshotJson: string;
  readonly createdAt: number;
}

interface OperationRow {
  readonly server_seq: number;
  readonly operation_json: string;
}

interface SnapshotTableRow {
  readonly document_id: string;
  readonly snapshot_seq: number;
  readonly snapshot_version: number;
  readonly snapshot_json: string;
  readonly created_at: number;
}

const OPERATIONS_DDL = `
      CREATE TABLE IF NOT EXISTS operations (
        server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        op_id TEXT NOT NULL,
        operation_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (document_id, op_id)
      );

      CREATE INDEX IF NOT EXISTS idx_operations_document_seq
        ON operations (document_id, server_seq);
`;

const SNAPSHOTS_DDL = `
      CREATE TABLE IF NOT EXISTS server_snapshots (
        document_id TEXT PRIMARY KEY,
        snapshot_seq INTEGER NOT NULL,
        snapshot_version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
`;

export class OperationStore {
  private readonly db: Database.Database;

  constructor(databasePath: string = DEFAULT_DATABASE_PATH) {
    if (databasePath !== ':memory:') {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }

    this.db = new Database(databasePath);
    migrateServerSchema(this.db);
  }

  getSchemaVersion(): number {
    return readUserVersion(this.db);
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  appendOperation(documentId: string, operation: TextOperation): AppendOperationResult {
    validateOperation(operation);

    const existing = this.db
      .prepare(
        `SELECT server_seq, operation_json
         FROM operations
         WHERE document_id = ? AND op_id = ?`,
      )
      .get(documentId, operation.opId) as OperationRow | undefined;

    if (existing) {
      const persisted = JSON.parse(existing.operation_json) as TextOperation;

      if (!operationsEqual(persisted, operation)) {
        throw new OperationIdentityConflictError(operation.opId);
      }

      return {
        serverSeq: existing.server_seq,
        inserted: false,
      };
    }

    const result = this.db
      .prepare(
        `INSERT INTO operations (document_id, op_id, operation_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(documentId, operation.opId, JSON.stringify(operation), Date.now());

    return {
      serverSeq: Number(result.lastInsertRowid),
      inserted: true,
    };
  }

  loadOperations(documentId: string): SequencedPersistedOperation[] {
    return this.loadOperationsAfter(documentId, 0, this.getLatestServerSeq(documentId));
  }

  loadOperationsAfter(
    documentId: string,
    afterServerSeq: number,
    throughServerSeq: number,
  ): SequencedPersistedOperation[] {
    const rows = this.db
      .prepare(
        `SELECT server_seq, operation_json
         FROM operations
         WHERE document_id = ?
           AND server_seq > ?
           AND server_seq <= ?
         ORDER BY server_seq ASC`,
      )
      .all(documentId, afterServerSeq, throughServerSeq) as OperationRow[];

    return rows.map(mapOperationRow);
  }

  loadOperationsThrough(
    documentId: string,
    throughServerSeq: number,
  ): SequencedPersistedOperation[] {
    const rows = this.db
      .prepare(
        `SELECT server_seq, operation_json
         FROM operations
         WHERE document_id = ?
           AND server_seq <= ?
         ORDER BY server_seq ASC`,
      )
      .all(documentId, throughServerSeq) as OperationRow[];

    return rows.map(mapOperationRow);
  }

  getLatestServerSeq(documentId: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(server_seq) AS latest
         FROM operations
         WHERE document_id = ?`,
      )
      .get(documentId) as { latest: number | null };

    return row.latest ?? 0;
  }

  countOperations(documentId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM operations
         WHERE document_id = ?`,
      )
      .get(documentId) as { count: number };

    return row.count;
  }

  countOperationsAfter(
    documentId: string,
    afterServerSeq: number,
    throughServerSeq: number,
  ): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM operations
         WHERE document_id = ?
           AND server_seq > ?
           AND server_seq <= ?`,
      )
      .get(documentId, afterServerSeq, throughServerSeq) as { count: number };

    return row.count;
  }

  loadSnapshotRow(documentId: string): ServerSnapshotRow | undefined {
    const row = this.db
      .prepare(
        `SELECT document_id, snapshot_seq, snapshot_version, snapshot_json, created_at
         FROM server_snapshots
         WHERE document_id = ?`,
      )
      .get(documentId) as SnapshotTableRow | undefined;

    if (!row) {
      return undefined;
    }

    return {
      documentId: row.document_id,
      snapshotSeq: row.snapshot_seq,
      snapshotVersion: row.snapshot_version,
      snapshotJson: row.snapshot_json,
      createdAt: row.created_at,
    };
  }

  saveSnapshotRow(row: ServerSnapshotRow): void {
    this.db
      .prepare(
        `INSERT INTO server_snapshots (
           document_id, snapshot_seq, snapshot_version, snapshot_json, created_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(document_id) DO UPDATE SET
           snapshot_seq = excluded.snapshot_seq,
           snapshot_version = excluded.snapshot_version,
           snapshot_json = excluded.snapshot_json,
           created_at = excluded.created_at`,
      )
      .run(row.documentId, row.snapshotSeq, row.snapshotVersion, row.snapshotJson, row.createdAt);
  }

  checkReady(): void {
    this.db.prepare('SELECT 1 AS ok').get();
  }

  close(): void {
    if (!this.db.open) {
      return;
    }

    this.db.close();
  }
}

function mapOperationRow(row: OperationRow): SequencedPersistedOperation {
  return {
    serverSeq: row.server_seq,
    operation: JSON.parse(row.operation_json) as TextOperation,
  };
}

function readUserVersion(db: Database.Database): number {
  return Number(db.pragma('user_version', { simple: true }));
}

function migrateServerSchema(db: Database.Database): void {
  const current = readUserVersion(db);

  if (current > SERVER_SCHEMA_VERSION) {
    throw new IncompatibleServerSchemaError(
      `SQLite user_version ${current} is newer than supported schema version ${SERVER_SCHEMA_VERSION}.`,
    );
  }

  if (current < 1) {
    db.transaction(() => {
      db.exec(OPERATIONS_DDL);
      db.pragma('user_version = 1');
    })();
  }

  if (readUserVersion(db) < 2) {
    db.transaction(() => {
      db.exec(SNAPSHOTS_DDL);
      db.pragma('user_version = 2');
    })();
  }
}

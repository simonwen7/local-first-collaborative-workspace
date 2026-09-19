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

export interface SequencedPersistedOperation {
  readonly serverSeq: number;
  readonly operation: TextOperation;
}

export interface AppendOperationResult {
  readonly serverSeq: number;
  readonly inserted: boolean;
}

interface OperationRow {
  readonly server_seq: number;
  readonly operation_json: string;
}

export class OperationStore {
  private readonly db: Database.Database;

  constructor(databasePath: string = DEFAULT_DATABASE_PATH) {
    if (databasePath !== ':memory:') {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }

    this.db = new Database(databasePath);
    this.db.exec(`
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
    `);
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

    return rows.map((row) => ({
      serverSeq: row.server_seq,
      operation: JSON.parse(row.operation_json) as TextOperation,
    }));
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

  close(): void {
    this.db.close();
  }
}

import { TextReplica, UnresolvedReplicaSnapshotError } from '@lfcw/crdt';
import type { TextReplicaSnapshot } from '@lfcw/crdt';
import type { SnapshotBootstrap, SyncMessage } from '@lfcw/protocol';
import type { ServerMetrics } from './observability/server-metrics.js';
import type { OperationStore, SequencedPersistedOperation } from './operation-store.js';

export interface SnapshotLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export const SNAPSHOT_OPERATION_THRESHOLD = 1000;
export const SERVER_SNAPSHOT_ENVELOPE_VERSION = 1;

export interface ServerSnapshotPayload {
  readonly documentId: string;
  readonly snapshotSeq: number;
  readonly snapshot: TextReplicaSnapshot;
}

export class ServerSnapshotManager {
  constructor(
    private readonly store: OperationStore,
    private readonly metrics: ServerMetrics,
    private readonly logger: SnapshotLogger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  buildSyncMessage(
    documentId: string,
    lastServerSeq: number,
    snapshotCapable: boolean,
  ): SyncMessage {
    return this.store.transaction(() => {
      const barrier = this.store.getLatestServerSeq(documentId);

      if (!snapshotCapable || lastServerSeq > 0) {
        return this.fullHistorySync(documentId, lastServerSeq, barrier);
      }

      const bootstrap = this.prepareSnapshotBootstrap(documentId, barrier);

      if (!bootstrap) {
        return this.fullHistorySync(documentId, lastServerSeq, barrier);
      }

      const suffix = this.store.loadOperationsAfter(documentId, bootstrap.snapshotSeq, barrier);
      const snapshotBootstrap: SnapshotBootstrap = {
        version: SERVER_SNAPSHOT_ENVELOPE_VERSION,
        snapshotSeq: bootstrap.snapshotSeq,
        snapshot: bootstrap.snapshot,
      };
      const snapshotBytes = Buffer.byteLength(JSON.stringify(bootstrap.snapshot));
      this.metrics.recordSnapshotBootstrap(snapshotBytes, suffix.length);
      this.logger.info(
        {
          documentId,
          snapshotSeq: bootstrap.snapshotSeq,
          snapshotBytes,
          suffixOperationCount: suffix.length,
        },
        'snapshot_bootstrap_sent',
      );

      return {
        type: 'sync',
        documentId,
        operations: suffix,
        latestServerSeq: barrier,
        snapshotBootstrap,
      };
    });
  }

  private fullHistorySync(documentId: string, lastServerSeq: number, barrier: number): SyncMessage {
    return {
      type: 'sync',
      documentId,
      operations: this.store.loadOperationsAfter(documentId, lastServerSeq, barrier),
      latestServerSeq: barrier,
    };
  }

  private prepareSnapshotBootstrap(
    documentId: string,
    barrier: number,
  ): ServerSnapshotPayload | undefined {
    const historyCount = this.store.countOperations(documentId);

    if (historyCount === 0 || barrier < 1) {
      return undefined;
    }

    const existing = this.loadValidSnapshot(documentId);

    if (!existing) {
      if (historyCount < SNAPSHOT_OPERATION_THRESHOLD) {
        return undefined;
      }

      return this.tryBuildSnapshot(documentId, barrier);
    }

    const suffixCount = this.store.countOperationsAfter(documentId, existing.snapshotSeq, barrier);

    if (suffixCount >= SNAPSHOT_OPERATION_THRESHOLD) {
      return this.tryBuildSnapshot(documentId, barrier) ?? existing;
    }

    return existing;
  }

  private loadValidSnapshot(documentId: string): ServerSnapshotPayload | undefined {
    const row = this.store.loadSnapshotRow(documentId);

    if (!row) {
      return undefined;
    }

    if (row.snapshotVersion !== SERVER_SNAPSHOT_ENVELOPE_VERSION || row.snapshotSeq < 1) {
      this.logger.warn({ documentId, snapshotSeq: row.snapshotSeq }, 'snapshot_cache_invalid');
      return undefined;
    }

    try {
      const snapshot = JSON.parse(row.snapshotJson) as TextReplicaSnapshot;
      TextReplica.fromSnapshot(snapshot);
      return {
        documentId,
        snapshotSeq: row.snapshotSeq,
        snapshot,
      };
    } catch {
      this.logger.warn({ documentId, snapshotSeq: row.snapshotSeq }, 'snapshot_cache_invalid');
      return undefined;
    }
  }

  private tryBuildSnapshot(documentId: string, barrier: number): ServerSnapshotPayload | undefined {
    const started = this.now();
    const prefix = this.store.loadOperationsThrough(documentId, barrier);

    try {
      const snapshot = exportPrefixSnapshot(prefix);
      const snapshotJson = JSON.stringify(snapshot);
      const durationMs = this.now() - started;
      this.store.saveSnapshotRow({
        documentId,
        snapshotSeq: barrier,
        snapshotVersion: SERVER_SNAPSHOT_ENVELOPE_VERSION,
        snapshotJson,
        createdAt: started,
      });
      this.metrics.recordSnapshotBuild();
      this.logger.info(
        {
          documentId,
          snapshotSeq: barrier,
          operationCount: prefix.length,
          snapshotBytes: Buffer.byteLength(snapshotJson),
          durationMs,
        },
        'snapshot_built',
      );
      return {
        documentId,
        snapshotSeq: barrier,
        snapshot,
      };
    } catch (error) {
      this.metrics.recordSnapshotBuildFailure();
      this.logger.warn(
        {
          documentId,
          snapshotSeq: barrier,
          operationCount: prefix.length,
          durationMs: this.now() - started,
          reason: error instanceof Error ? error.name : 'unknown',
        },
        'snapshot_build_failed',
      );
      return undefined;
    }
  }
}

function exportPrefixSnapshot(prefix: readonly SequencedPersistedOperation[]): TextReplicaSnapshot {
  const replica = new TextReplica();
  replica.applyAll(prefix.map((item) => item.operation));

  if (replica.getUnresolvedOperationIds().length > 0) {
    throw new UnresolvedReplicaSnapshotError(replica.getUnresolvedOperationIds());
  }

  return replica.exportSnapshot();
}

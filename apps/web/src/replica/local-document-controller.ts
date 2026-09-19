import { OperationIdentityConflictError, TextReplica } from '@lfcw/crdt';
import type { TextOperation, TextReplicaSnapshot, VisibleElement } from '@lfcw/crdt';
import type { SequencedOperation, SnapshotBootstrap } from '@lfcw/protocol';
import { computeLocalTextEdit } from '../editor/text-edit';
import { LocalWorkspaceDatabase } from '../persistence/database';
import {
  DEFAULT_DOCUMENT_ID,
  DEFAULT_DOCUMENT_TITLE,
  InvalidServerBaselineError,
  LocalDocumentStore,
} from '../persistence/local-document-store';
import type { LocalDocumentStoreOptions } from '../persistence/local-document-store';
import type { ReplicaSnapshotRecord, ServerBaselineRecord } from '../persistence/database';

export class ControllerClosedError extends Error {
  constructor() {
    super('Local document controller is closed.');
    this.name = 'ControllerClosedError';
  }
}

export const SNAPSHOT_OPERATION_INTERVAL = 1000;

export interface LocalDocumentSnapshot {
  readonly documentId: string;
  readonly title: string;
  readonly text: string;
  readonly visibleElements: readonly VisibleElement[];
}

export interface LocalDocumentIdentity {
  readonly documentId: string;
  readonly clientId: string;
}

export interface LocalEditResult {
  readonly snapshot: LocalDocumentSnapshot;
  readonly operations: readonly TextOperation[];
}

export interface LocalDocumentControllerOptions extends LocalDocumentStoreOptions {
  readonly databaseName?: string;
  readonly documentId?: string;
  readonly defaultTitle?: string;
  readonly snapshotInterval?: number;
  readonly persistCheckpoint?: (
    documentId: string,
    snapshot: TextReplicaSnapshot,
    knownOperationCount: number,
  ) => Promise<void>;
}

export class LocalDocumentController {
  private writeQueue: Promise<void> = Promise.resolve();
  private lastSnapshotOperationCount = 0;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private replica: TextReplica;
  private hasServerBaseline: boolean;

  private constructor(
    private readonly store: LocalDocumentStore,
    replica: TextReplica,
    private readonly documentId: string,
    private readonly clientId: string,
    private readonly title: string,
    private readonly snapshotInterval: number,
    private readonly persistCheckpoint: (
      documentId: string,
      snapshot: TextReplicaSnapshot,
      knownOperationCount: number,
    ) => Promise<void>,
    hasServerBaseline: boolean,
  ) {
    this.replica = replica;
    this.hasServerBaseline = hasServerBaseline;
  }

  static async create(
    options: LocalDocumentControllerOptions = {},
  ): Promise<LocalDocumentController> {
    const snapshotInterval = resolveSnapshotInterval(options.snapshotInterval);
    const documentId = options.documentId ?? DEFAULT_DOCUMENT_ID;
    const defaultTitle =
      options.defaultTitle ??
      (documentId === DEFAULT_DOCUMENT_ID ? DEFAULT_DOCUMENT_TITLE : 'Untitled Document');
    const database = new LocalWorkspaceDatabase(options.databaseName);

    const store = new LocalDocumentStore(database, {
      ...(options.clientIdFactory !== undefined
        ? { clientIdFactory: options.clientIdFactory }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });

    const initialized = await store.initialize(documentId, defaultTitle);
    const operations = await store.loadOperations(initialized.document.id);
    const baseline = await store.loadServerBaseline(initialized.document.id);
    const checkpoint = baseline
      ? undefined
      : await store.loadReplicaSnapshot(initialized.document.id);
    const persistCheckpoint =
      options.persistCheckpoint ??
      ((documentId, snapshot, knownOperationCount) =>
        store.saveReplicaSnapshot(documentId, snapshot, knownOperationCount));

    let replica: TextReplica;
    let lastSnapshotOperationCount = 0;
    const lastServerSeq = await store.getLastServerSeq(initialized.document.id);

    try {
      if (baseline) {
        replica = restoreFromServerBaseline(baseline, operations, lastServerSeq);
      } else {
        const restored = restoreReplica(operations, checkpoint);
        replica = restored.replica;
        lastSnapshotOperationCount = restored.lastSnapshotOperationCount;
      }
    } catch (error) {
      store.close();
      throw error;
    }

    const unresolved = replica.getUnresolvedOperationIds();

    if (unresolved.length > 0) {
      store.close();

      throw new Error(
        `Stored local operation log has unresolved dependencies: ${unresolved.join(', ')}`,
      );
    }

    const controller = new LocalDocumentController(
      store,
      replica,
      initialized.document.id,
      initialized.clientMeta.clientId,
      initialized.document.title,
      snapshotInterval,
      persistCheckpoint,
      Boolean(baseline),
    );
    controller.lastSnapshotOperationCount = lastSnapshotOperationCount;
    await controller.maybeCreateCheckpoint();
    return controller;
  }

  getIdentity(): LocalDocumentIdentity {
    return {
      documentId: this.documentId,
      clientId: this.clientId,
    };
  }

  getLastServerSeq(): Promise<number> {
    return this.store.getLastServerSeq(this.documentId);
  }

  loadPendingOperations(): Promise<TextOperation[]> {
    return this.store.loadPendingOperations(this.documentId);
  }

  isSnapshotBootstrapEligible(): Promise<boolean> {
    return this.store.isSnapshotBootstrapEligible(this.documentId);
  }

  getSnapshot(): LocalDocumentSnapshot {
    return {
      documentId: this.documentId,
      title: this.title,
      text: this.replica.materialize(),
      visibleElements: this.replica.getVisibleElements(),
    };
  }

  replaceText(nextText: string): Promise<LocalEditResult> {
    if (this.closing) {
      return Promise.reject(new ControllerClosedError());
    }

    const result = this.writeQueue.then(() => this.replaceTextNow(nextText));

    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  applyServerOperations(
    sequencedOperations: readonly SequencedOperation[],
    confirmedThroughServerSeq: number,
  ): Promise<LocalDocumentSnapshot> {
    if (this.closing) {
      return Promise.reject(new ControllerClosedError());
    }

    const result = this.writeQueue.then(() =>
      this.applyServerOperationsNow(sequencedOperations, confirmedThroughServerSeq),
    );

    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  installServerSnapshot(
    bootstrap: SnapshotBootstrap,
    sequencedOperations: readonly SequencedOperation[],
    confirmedThroughServerSeq: number,
  ): Promise<LocalDocumentSnapshot> {
    if (this.closing) {
      return Promise.reject(new ControllerClosedError());
    }

    const result = this.writeQueue.then(() =>
      this.installServerSnapshotNow(bootstrap, sequencedOperations, confirmedThroughServerSeq),
    );

    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  whenIdle(): Promise<void> {
    return this.writeQueue;
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closing = true;
    this.closePromise = this.finalizeClose();
    return this.closePromise;
  }

  private async finalizeClose(): Promise<void> {
    try {
      await this.writeQueue;
    } finally {
      this.store.close();
    }
  }

  private async replaceTextNow(nextText: string): Promise<LocalEditResult> {
    const edit = computeLocalTextEdit(this.replica.getVisibleElements(), nextText);

    if (!edit) {
      return {
        snapshot: this.getSnapshot(),
        operations: [],
      };
    }

    const operations = await this.store.persistLocalTextEdit(this.documentId, edit);

    this.replica.applyAll(operations);
    await this.maybeCreateCheckpoint();

    return {
      snapshot: this.getSnapshot(),
      operations,
    };
  }

  private async applyServerOperationsNow(
    sequencedOperations: readonly SequencedOperation[],
    confirmedThroughServerSeq: number,
  ): Promise<LocalDocumentSnapshot> {
    await this.store.persistServerOperations(
      this.documentId,
      sequencedOperations,
      confirmedThroughServerSeq,
    );
    this.replica.applyAll(sequencedOperations.map((item) => item.operation));
    await this.maybeCreateCheckpoint();
    return this.getSnapshot();
  }

  private async installServerSnapshotNow(
    bootstrap: SnapshotBootstrap,
    sequencedOperations: readonly SequencedOperation[],
    confirmedThroughServerSeq: number,
  ): Promise<LocalDocumentSnapshot> {
    this.replica = await this.store.installServerBaseline(
      this.documentId,
      bootstrap,
      sequencedOperations,
      confirmedThroughServerSeq,
    );
    this.hasServerBaseline = true;
    return this.getSnapshot();
  }

  private async maybeCreateCheckpoint(): Promise<void> {
    if (this.hasServerBaseline) {
      return;
    }
    if (this.replica.getUnresolvedOperationIds().length > 0) {
      return;
    }

    const knownOperationCount = this.replica.getKnownOperationCount();

    if (knownOperationCount - this.lastSnapshotOperationCount < this.snapshotInterval) {
      return;
    }

    try {
      const snapshot = this.replica.exportSnapshot();
      await this.persistCheckpoint(this.documentId, snapshot, knownOperationCount);
      this.lastSnapshotOperationCount = knownOperationCount;
    } catch {
      // Checkpoint cache failure must not fail a successful local persist/apply.
    }
  }
}

function resolveSnapshotInterval(value: number | undefined): number {
  if (value === undefined) {
    return SNAPSHOT_OPERATION_INTERVAL;
  }

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('snapshotInterval must be a positive safe integer.');
  }

  return value;
}

function restoreFromServerBaseline(
  baseline: ServerBaselineRecord,
  operations: readonly TextOperation[],
  lastServerSeq: number,
): TextReplica {
  if (!Number.isSafeInteger(baseline.snapshotSeq) || baseline.snapshotSeq < 1) {
    throw new InvalidServerBaselineError(
      'Server baseline snapshotSeq must be a positive safe integer.',
    );
  }

  if (!Number.isSafeInteger(lastServerSeq) || lastServerSeq < baseline.snapshotSeq) {
    throw new InvalidServerBaselineError(
      'syncState.lastServerSeq must be at least the installed server baseline snapshotSeq.',
    );
  }

  try {
    const replica = TextReplica.fromSnapshot(baseline.snapshot);
    replica.applyAll(operations);
    return replica;
  } catch (error) {
    if (error instanceof InvalidServerBaselineError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Invalid server baseline.';
    throw new InvalidServerBaselineError(message);
  }
}

function restoreReplica(
  operations: readonly TextOperation[],
  checkpoint: ReplicaSnapshotRecord | undefined,
): { replica: TextReplica; lastSnapshotOperationCount: number } {
  if (checkpoint) {
    try {
      const restored = TextReplica.fromSnapshot(checkpoint.snapshot);

      if (restored.getKnownOperationCount() !== checkpoint.knownOperationCount) {
        throw new Error('Checkpoint known-operation count does not match restored replica.');
      }

      const canonicalIds = new Set(operations.map((operation) => operation.opId));

      for (const operationId of restored.getKnownOperationIds()) {
        if (!canonicalIds.has(operationId)) {
          throw new Error(`Checkpoint contains operation "${operationId}" missing from the log.`);
        }
      }

      restored.applyAll(operations);
      return {
        replica: restored,
        lastSnapshotOperationCount: checkpoint.knownOperationCount,
      };
    } catch (error) {
      if (error instanceof OperationIdentityConflictError || error instanceof Error) {
        const replica = new TextReplica();
        replica.applyAll(operations);
        return {
          replica,
          lastSnapshotOperationCount: 0,
        };
      }

      throw error;
    }
  }

  const replica = new TextReplica();
  replica.applyAll(operations);
  return {
    replica,
    lastSnapshotOperationCount: 0,
  };
}

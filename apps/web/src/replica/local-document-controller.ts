import { TextReplica } from '@lfcw/crdt';
import type { VisibleElement } from '@lfcw/crdt';
import { computeLocalTextEdit } from '../editor/text-edit';
import { LocalWorkspaceDatabase } from '../persistence/database';
import { LocalDocumentStore } from '../persistence/local-document-store';
import type { LocalDocumentStoreOptions } from '../persistence/local-document-store';

export interface LocalDocumentSnapshot {
  readonly documentId: string;
  readonly title: string;
  readonly text: string;
  readonly visibleElements: readonly VisibleElement[];
}

export interface LocalDocumentControllerOptions extends LocalDocumentStoreOptions {
  readonly databaseName?: string;
}

export class LocalDocumentController {
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly store: LocalDocumentStore,
    private readonly replica: TextReplica,
    private readonly documentId: string,
    private readonly title: string,
  ) {}

  static async create(
    options: LocalDocumentControllerOptions = {},
  ): Promise<LocalDocumentController> {
    const database = new LocalWorkspaceDatabase(options.databaseName);

    const store = new LocalDocumentStore(database, {
      ...(options.clientIdFactory !== undefined
        ? { clientIdFactory: options.clientIdFactory }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });

    const initialized = await store.initialize();
    const replica = new TextReplica();

    const operations = await store.loadOperations(initialized.document.id);

    replica.applyAll(operations);

    const unresolved = replica.getUnresolvedOperationIds();

    if (unresolved.length > 0) {
      store.close();

      throw new Error(
        `Stored local operation log has unresolved dependencies: ${unresolved.join(', ')}`,
      );
    }

    return new LocalDocumentController(
      store,
      replica,
      initialized.document.id,
      initialized.document.title,
    );
  }

  getSnapshot(): LocalDocumentSnapshot {
    return {
      documentId: this.documentId,
      title: this.title,
      text: this.replica.materialize(),
      visibleElements: this.replica.getVisibleElements(),
    };
  }

  replaceText(nextText: string): Promise<LocalDocumentSnapshot> {
    const result = this.writeQueue.then(() => this.replaceTextNow(nextText));

    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  close(): void {
    this.store.close();
  }

  private async replaceTextNow(nextText: string): Promise<LocalDocumentSnapshot> {
    const edit = computeLocalTextEdit(this.replica.getVisibleElements(), nextText);

    if (!edit) {
      return this.getSnapshot();
    }

    const operations = await this.store.persistLocalTextEdit(this.documentId, edit);

    this.replica.applyAll(operations);

    return this.getSnapshot();
  }
}

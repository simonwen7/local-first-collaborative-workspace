import { ROOT_ID, TextReplica, createInsertOperation } from '@lfcw/crdt';
import type { AnchorId, TextOperation } from '@lfcw/crdt';
import { parseServerMessage } from '@lfcw/protocol';
import { segmentGraphemes } from '../editor/graphemes';
import { resolveSyncUrl } from '../sync/sync-url';

export const DEMO_COLLABORATOR_NAME = 'Alex (demo)';

export const DEMO_COLLABORATOR_PHRASE = 'A second replica joined and typed this. 👋';

export type DemoCollaboratorState = 'idle' | 'connecting' | 'joined' | 'typing' | 'done' | 'error';

export interface DemoCollaboratorOptions {
  readonly documentId: string;
  readonly url?: string;
  readonly displayName?: string;
  readonly phrase?: string;
  readonly keystrokeDelayMs?: number;
  readonly onStateChange?: (state: DemoCollaboratorState) => void;
}

/**
 * A second, genuinely independent replica.
 *
 * This is not a UI simulation: the collaborator opens its own WebSocket to
 * `/sync`, joins with a distinct client identity, maintains its own
 * `TextReplica` and Lamport clock, and submits real insert operations that the
 * server sequences into SQLite. The primary client observes those edits through
 * the normal synchronization path with no special-casing.
 */
export class DemoCollaborator {
  private readonly documentId: string;
  private readonly url: string;
  private readonly displayName: string;
  private readonly phrase: string;
  private readonly keystrokeDelayMs: number;
  private readonly onStateChange?: (state: DemoCollaboratorState) => void;
  readonly clientId: string;

  private socket: WebSocket | null = null;
  private replica = new TextReplica();
  private lamport = 0;
  private counter = 0;
  private anchorId: AnchorId | null = null;
  private state: DemoCollaboratorState = 'idle';
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: string[] = [];
  private disposed = false;

  constructor(options: DemoCollaboratorOptions) {
    this.documentId = options.documentId;
    this.url = options.url ?? resolveSyncUrl();
    this.displayName = options.displayName ?? DEMO_COLLABORATOR_NAME;
    this.phrase = options.phrase ?? DEMO_COLLABORATOR_PHRASE;
    this.keystrokeDelayMs = options.keystrokeDelayMs ?? 55;
    this.clientId = `demo-${randomSuffix()}`;

    if (options.onStateChange !== undefined) {
      this.onStateChange = options.onStateChange;
    }
  }

  getState(): DemoCollaboratorState {
    return this.state;
  }

  start(): void {
    if (this.disposed || this.socket) {
      return;
    }

    this.setState('connecting');

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        return;
      }

      socket.send(
        JSON.stringify({
          type: 'join',
          documentId: this.documentId,
          clientId: this.clientId,
          lastServerSeq: 0,
          displayName: this.displayName,
        }),
      );
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) {
        return;
      }

      this.handleMessage(event.data);
    });

    socket.addEventListener('error', () => {
      if (this.socket === socket) {
        this.setState('error');
      }
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = null;
      this.clearTypingTimer();

      if (this.state !== 'done' && this.state !== 'error') {
        this.setState('idle');
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.clearTypingTimer();
    this.queue = [];

    const socket = this.socket;
    this.socket = null;

    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }
  }

  private handleMessage(data: unknown): void {
    let message;

    try {
      message = parseServerMessage(JSON.parse(typeof data === 'string' ? data : String(data)));
    } catch {
      this.setState('error');
      return;
    }

    if (message.type === 'error') {
      this.setState('error');
      return;
    }

    if (message.type === 'presence' || message.documentId !== this.documentId) {
      return;
    }

    if (message.type === 'operation') {
      this.ingest([message.operation]);
      return;
    }

    // The collaborator joins from sequence 0 without advertising the snapshot
    // capability, so the server always replies with full history. A snapshot
    // here would mean the anchor is unknown, so refuse rather than guess.
    if (message.snapshotBootstrap) {
      this.setState('error');
      return;
    }

    this.ingest(message.operations.map((item) => item.operation));
    this.setState('joined');
    this.beginTyping();
  }

  private ingest(operations: readonly TextOperation[]): void {
    for (const operation of operations) {
      if (operation.lamport > this.lamport) {
        this.lamport = operation.lamport;
      }
    }

    this.replica.applyAll(operations);
  }

  private beginTyping(): void {
    if (this.disposed || this.queue.length > 0 || this.state === 'done') {
      return;
    }

    const visible = this.replica.getVisibleElements();
    const separator = visible.length > 0 ? '\n\n' : '';
    this.anchorId = visible.at(-1)?.id ?? null;
    this.queue = segmentGraphemes(`${separator}${this.phrase}`);
    this.setState('typing');
    this.scheduleKeystroke();
  }

  private scheduleKeystroke(): void {
    this.clearTypingTimer();

    this.typingTimer = setTimeout(() => {
      this.typingTimer = null;
      this.typeNext();
    }, this.keystrokeDelayMs);
  }

  private typeNext(): void {
    const value = this.queue.shift();
    const socket = this.socket;

    if (value === undefined) {
      this.setState('done');
      return;
    }

    if (this.disposed || !socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.counter += 1;
    this.lamport += 1;

    const operation = createInsertOperation({
      clientId: this.clientId,
      counter: this.counter,
      lamport: this.lamport,
      afterId: this.anchorId ?? ROOT_ID,
      value,
    });

    this.replica.apply(operation);
    this.anchorId = operation.opId;

    socket.send(
      JSON.stringify({
        type: 'submit-operation',
        documentId: this.documentId,
        operation,
      }),
    );

    if (this.queue.length === 0) {
      this.setState('done');
      return;
    }

    this.scheduleKeystroke();
  }

  private clearTypingTimer(): void {
    if (this.typingTimer === null) {
      return;
    }

    clearTimeout(this.typingTimer);
    this.typingTimer = null;
  }

  private setState(state: DemoCollaboratorState): void {
    if (this.state === state) {
      return;
    }

    this.state = state;
    this.onStateChange?.(state);
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

import type { TextOperation } from '@lfcw/crdt';
import { parseServerMessage } from '@lfcw/protocol';

export const DEFAULT_SYNC_URL = 'ws://127.0.0.1:3001/sync';

export type SyncStatus = 'connecting' | 'online' | 'offline' | 'error';

export interface DocumentSyncClientOptions {
  readonly documentId: string;
  readonly clientId: string;
  readonly url?: string;
  readonly onRemoteOperations: (operations: readonly TextOperation[]) => Promise<void> | void;
  readonly onStatusChange?: (status: SyncStatus) => void;
}

export class DocumentSyncClient {
  private readonly documentId: string;
  private readonly clientId: string;
  private readonly url: string;
  private readonly onRemoteOperations: DocumentSyncClientOptions['onRemoteOperations'];
  private readonly onStatusChange?: (status: SyncStatus) => void;

  private socket: WebSocket | null = null;
  private status: SyncStatus = 'offline';
  private inbound: Promise<void> = Promise.resolve();
  private startupQueue: TextOperation[] = [];
  private waitingForInitialSync = false;
  private closedByClient = false;

  constructor(options: DocumentSyncClientOptions) {
    this.documentId = options.documentId;
    this.clientId = options.clientId;
    this.url = options.url ?? resolveSyncUrl();
    this.onRemoteOperations = options.onRemoteOperations;

    if (options.onStatusChange !== undefined) {
      this.onStatusChange = options.onStatusChange;
    }
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  connect(): void {
    if (this.socket) {
      return;
    }

    this.closedByClient = false;
    this.waitingForInitialSync = false;
    this.setStatus('connecting');

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        return;
      }

      this.waitingForInitialSync = true;
      socket.send(
        JSON.stringify({
          type: 'join',
          documentId: this.documentId,
          clientId: this.clientId,
        }),
      );
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) {
        return;
      }

      this.enqueueInbound(() => this.handleMessage(event.data));
    });

    socket.addEventListener('error', () => {
      if (this.socket !== socket || this.closedByClient) {
        return;
      }

      this.setStatus('error');
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = null;
      this.waitingForInitialSync = false;
      this.startupQueue = [];

      if (!this.closedByClient && this.status !== 'error') {
        this.setStatus('offline');
      }
    });
  }

  submitOperations(operations: readonly TextOperation[]): void {
    if (operations.length === 0) {
      return;
    }

    if (this.status === 'online' && this.socket?.readyState === WebSocket.OPEN) {
      this.sendOperations(operations);
      return;
    }

    if (this.status === 'connecting' || this.waitingForInitialSync) {
      this.startupQueue.push(...operations);
    }
  }

  close(): void {
    this.closedByClient = true;
    this.waitingForInitialSync = false;
    this.startupQueue = [];

    const socket = this.socket;
    this.socket = null;

    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }

    this.setStatus('offline');
  }

  private enqueueInbound(work: () => Promise<void>): void {
    this.inbound = this.inbound.then(work, work).catch((error: unknown) => {
      this.setStatus('error');

      if (error instanceof Error) {
        throw error;
      }
    });
  }

  private async handleMessage(data: unknown): Promise<void> {
    let parsed: unknown;

    try {
      parsed = typeof data === 'string' ? JSON.parse(data) : JSON.parse(String(data));
    } catch {
      this.setStatus('error');
      return;
    }

    let message;

    try {
      message = parseServerMessage(parsed);
    } catch {
      this.setStatus('error');
      return;
    }

    if (message.type === 'error') {
      this.setStatus('error');
      return;
    }

    if (message.documentId !== this.documentId) {
      return;
    }

    if (message.type === 'sync') {
      await this.onRemoteOperations(message.operations.map((item) => item.operation));
      this.waitingForInitialSync = false;
      this.setStatus('online');
      this.flushStartupQueue();
      return;
    }

    await this.onRemoteOperations([message.operation]);
  }

  private flushStartupQueue(): void {
    if (this.startupQueue.length === 0) {
      return;
    }

    const queued = this.startupQueue;
    this.startupQueue = [];
    this.sendOperations(queued);
  }

  private sendOperations(operations: readonly TextOperation[]): void {
    const socket = this.socket;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    for (const operation of operations) {
      socket.send(
        JSON.stringify({
          type: 'submit-operation',
          documentId: this.documentId,
          operation,
        }),
      );
    }
  }

  private setStatus(status: SyncStatus): void {
    if (this.status === status) {
      return;
    }

    this.status = status;
    this.onStatusChange?.(status);
  }
}

function resolveSyncUrl(): string {
  const configured = import.meta.env.VITE_SYNC_URL;

  if (typeof configured === 'string' && configured.length > 0) {
    return configured;
  }

  return DEFAULT_SYNC_URL;
}

import type { TextOperation } from '@lfcw/crdt';
import type { SequencedOperation } from '@lfcw/protocol';
import { parseServerMessage } from '@lfcw/protocol';
import { DEFAULT_DEV_SYNC_URL, resolveSyncUrl } from './sync-url';

export const DEFAULT_SYNC_URL = DEFAULT_DEV_SYNC_URL;

export const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;

export type SyncStatus = 'offline' | 'connecting' | 'syncing' | 'online' | 'error';

export interface DocumentSyncClientOptions {
  readonly documentId: string;
  readonly clientId: string;
  readonly url?: string;
  readonly getLastServerSeq: () => Promise<number> | number;
  readonly loadPendingOperations: () => Promise<readonly TextOperation[]>;
  readonly onServerOperations: (
    sequencedOperations: readonly SequencedOperation[],
    confirmedThroughServerSeq: number,
  ) => Promise<void> | void;
  readonly onStatusChange?: (status: SyncStatus) => void;
}

export class DocumentSyncClient {
  private readonly documentId: string;
  private readonly clientId: string;
  private readonly url: string;
  private readonly getLastServerSeq: DocumentSyncClientOptions['getLastServerSeq'];
  private readonly loadPendingOperations: DocumentSyncClientOptions['loadPendingOperations'];
  private readonly onServerOperations: DocumentSyncClientOptions['onServerOperations'];
  private readonly onStatusChange?: (status: SyncStatus) => void;

  private socket: WebSocket | null = null;
  private status: SyncStatus = 'offline';
  private inbound: Promise<void> = Promise.resolve();
  private closedByClient = false;
  private catchUpComplete = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: DocumentSyncClientOptions) {
    this.documentId = options.documentId;
    this.clientId = options.clientId;
    this.url = options.url ?? resolveSyncUrl();
    this.getLastServerSeq = options.getLastServerSeq;
    this.loadPendingOperations = options.loadPendingOperations;
    this.onServerOperations = options.onServerOperations;

    if (options.onStatusChange !== undefined) {
      this.onStatusChange = options.onStatusChange;
    }
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  connect(): void {
    if (this.closedByClient || this.socket) {
      return;
    }

    this.catchUpComplete = false;
    this.setStatus('connecting');

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        return;
      }

      void this.sendJoin(socket);
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
      this.catchUpComplete = false;

      if (this.closedByClient) {
        this.setStatus('offline');
        return;
      }

      this.setStatus('offline');
      this.scheduleReconnect();
    });
  }

  submitOperations(operations: readonly TextOperation[]): void {
    if (operations.length === 0) {
      return;
    }

    if (!this.catchUpComplete || this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.setStatus('syncing');
    this.sendOperations(operations);
  }

  close(): void {
    this.closedByClient = true;
    this.catchUpComplete = false;
    this.cancelReconnect();

    const socket = this.socket;
    this.socket = null;

    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }

    this.setStatus('offline');
  }

  private async sendJoin(socket: WebSocket): Promise<void> {
    const lastServerSeq = await this.getLastServerSeq();

    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: 'join',
        documentId: this.documentId,
        clientId: this.clientId,
        lastServerSeq,
      }),
    );
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
      this.setStatus('syncing');
      await this.onServerOperations(message.operations, message.latestServerSeq);
      this.catchUpComplete = true;
      this.reconnectAttempt = 0;
      await this.flushOutbox();
      await this.refreshOnlineStatus();
      return;
    }

    await this.onServerOperations(
      [
        {
          serverSeq: message.serverSeq,
          operation: message.operation,
        },
      ],
      message.serverSeq,
    );
    await this.refreshOnlineStatus();
  }

  private async flushOutbox(): Promise<void> {
    if (!this.catchUpComplete || this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    const pending = await this.loadPendingOperations();

    if (pending.length === 0) {
      return;
    }

    this.setStatus('syncing');
    this.sendOperations(pending);
  }

  private async refreshOnlineStatus(): Promise<void> {
    if (!this.catchUpComplete || this.closedByClient) {
      return;
    }

    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    const pending = await this.loadPendingOperations();

    if (pending.length === 0) {
      this.setStatus('online');
      return;
    }

    this.setStatus('syncing');
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

  private scheduleReconnect(): void {
    if (this.closedByClient || this.reconnectTimer !== null || this.socket) {
      return;
    }

    const cappedIndex = Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    const delayMs = RECONNECT_DELAYS_MS[cappedIndex] ?? 4000;
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (this.closedByClient || this.socket) {
        return;
      }

      this.connect();
    }, delayMs);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer === null) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setStatus(status: SyncStatus): void {
    if (this.status === status) {
      return;
    }

    this.status = status;
    this.onStatusChange?.(status);
  }
}

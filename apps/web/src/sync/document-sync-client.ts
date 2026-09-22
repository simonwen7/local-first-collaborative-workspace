import type { TextOperation } from '@lfcw/crdt';
import type { PresenceParticipant, SequencedOperation, SnapshotBootstrap } from '@lfcw/protocol';
import { SNAPSHOT_BOOTSTRAP_CAPABILITY, parseServerMessage } from '@lfcw/protocol';
import {
  InvalidSnapshotBootstrapError,
  SnapshotBootstrapIneligibleError,
} from '../persistence/local-document-store';
import type { SyncTelemetry } from '../telemetry/sync-telemetry';
import { DEFAULT_DEV_SYNC_URL, resolveSyncUrl } from './sync-url';

export const DEFAULT_SYNC_URL = DEFAULT_DEV_SYNC_URL;

export const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;

/** Consecutive failed connects before the UI treats the server as unreachable. */
export const UNREACHABLE_AFTER_ATTEMPTS = 3;

export type SyncStatus = 'offline' | 'connecting' | 'syncing' | 'online' | 'error';

export interface DocumentSyncClientOptions {
  readonly documentId: string;
  readonly clientId: string;
  readonly url?: string;
  readonly displayName?: string;
  readonly telemetry?: SyncTelemetry;
  readonly getLastServerSeq: () => Promise<number> | number;
  readonly loadPendingOperations: () => Promise<readonly TextOperation[]>;
  readonly onServerOperations: (
    sequencedOperations: readonly SequencedOperation[],
    confirmedThroughServerSeq: number,
  ) => Promise<void> | void;
  readonly isSnapshotBootstrapEligible?: () => Promise<boolean> | boolean;
  readonly onSnapshotBootstrap?: (
    bootstrap: SnapshotBootstrap,
    sequencedOperations: readonly SequencedOperation[],
    confirmedThroughServerSeq: number,
  ) => Promise<void> | void;
  readonly onStatusChange?: (status: SyncStatus) => void;
  readonly onPresence?: (participants: readonly PresenceParticipant[]) => void;
  readonly onServerSeqChange?: (latestServerSeq: number) => void;
  readonly onUnreachableChange?: (unreachable: boolean) => void;
}

export class DocumentSyncClient {
  private readonly documentId: string;
  private readonly clientId: string;
  private readonly url: string;
  private readonly getLastServerSeq: DocumentSyncClientOptions['getLastServerSeq'];
  private readonly loadPendingOperations: DocumentSyncClientOptions['loadPendingOperations'];
  private readonly onServerOperations: DocumentSyncClientOptions['onServerOperations'];
  private readonly isSnapshotBootstrapEligible?: DocumentSyncClientOptions['isSnapshotBootstrapEligible'];
  private readonly onSnapshotBootstrap?: DocumentSyncClientOptions['onSnapshotBootstrap'];
  private readonly onStatusChange?: (status: SyncStatus) => void;
  private readonly onPresence?: (participants: readonly PresenceParticipant[]) => void;
  private readonly onServerSeqChange?: (latestServerSeq: number) => void;
  private readonly onUnreachableChange?: (unreachable: boolean) => void;
  private readonly displayName?: string;
  private readonly telemetry?: SyncTelemetry;

  private socket: WebSocket | null = null;
  private status: SyncStatus = 'offline';
  private inbound: Promise<void> = Promise.resolve();
  private closedByClient = false;
  private suspended = false;
  private unreachable = false;
  private consecutiveFailures = 0;
  private catchUpComplete = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotBootstrapDisabled = false;
  private lastInboundError: unknown = null;

  constructor(options: DocumentSyncClientOptions) {
    this.documentId = options.documentId;
    this.clientId = options.clientId;
    this.url = options.url ?? resolveSyncUrl();
    this.getLastServerSeq = options.getLastServerSeq;
    this.loadPendingOperations = options.loadPendingOperations;
    this.onServerOperations = options.onServerOperations;

    if (options.isSnapshotBootstrapEligible !== undefined) {
      this.isSnapshotBootstrapEligible = options.isSnapshotBootstrapEligible;
    }

    if (options.onSnapshotBootstrap !== undefined) {
      this.onSnapshotBootstrap = options.onSnapshotBootstrap;
    }

    if (options.onStatusChange !== undefined) {
      this.onStatusChange = options.onStatusChange;
    }

    if (options.onPresence !== undefined) {
      this.onPresence = options.onPresence;
    }

    if (options.onServerSeqChange !== undefined) {
      this.onServerSeqChange = options.onServerSeqChange;
    }

    if (options.onUnreachableChange !== undefined) {
      this.onUnreachableChange = options.onUnreachableChange;
    }

    if (options.displayName !== undefined) {
      this.displayName = options.displayName;
    }

    if (options.telemetry !== undefined) {
      this.telemetry = options.telemetry;
    }
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  isUnreachable(): boolean {
    return this.unreachable;
  }

  /**
   * The most recent error thrown while processing an inbound message. Exposed
   * so callers can surface it instead of relying on an unhandled rejection.
   */
  getLastInboundError(): unknown {
    return this.lastInboundError;
  }

  /**
   * Operator-controlled offline mode. This closes the real socket and stops
   * reconnect attempts; it does not touch local durability, so editing and
   * IndexedDB persistence continue exactly as they do during a real network
   * partition.
   */
  suspend(): void {
    if (this.suspended) {
      return;
    }

    this.suspended = true;
    this.catchUpComplete = false;
    this.cancelReconnect();

    const socket = this.socket;
    this.socket = null;

    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }

    this.onPresence?.([]);
    this.setStatus('offline');
    this.telemetry?.emit({
      stage: 'outbox',
      documentId: this.documentId,
      message: 'Network suspended. Edits continue queuing locally.',
    });
  }

  resume(): void {
    if (!this.suspended) {
      return;
    }

    this.suspended = false;
    this.reconnectAttempt = 0;
    this.connect();
  }

  /**
   * Immediate reconnect from either intentional suspend or an unexpected drop.
   * Unlike `resume()`, this is safe to call when the replica is not suspended:
   * it cancels backoff and opens a socket now.
   */
  retry(): void {
    if (this.closedByClient) {
      return;
    }

    this.suspended = false;
    this.cancelReconnect();
    this.reconnectAttempt = 0;

    if (this.socket) {
      return;
    }

    this.connect();
  }

  connect(): void {
    if (this.closedByClient || this.suspended || this.socket) {
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
      this.onPresence?.([]);

      if (this.closedByClient) {
        this.setStatus('offline');
        return;
      }

      this.noteConnectionFailure();
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

    const advertiseSnapshot =
      !this.snapshotBootstrapDisabled &&
      lastServerSeq === 0 &&
      this.isSnapshotBootstrapEligible !== undefined &&
      (await this.isSnapshotBootstrapEligible());

    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: 'join',
        documentId: this.documentId,
        clientId: this.clientId,
        lastServerSeq,
        ...(advertiseSnapshot ? { capabilities: [SNAPSHOT_BOOTSTRAP_CAPABILITY] } : {}),
        ...(this.displayName !== undefined ? { displayName: this.displayName } : {}),
      }),
    );
  }

  /**
   * Serialize inbound message handling.
   *
   * Failures are recorded rather than rethrown. Rethrowing left the tail of the
   * chain in a rejected state, and because nothing awaits that tail it surfaced
   * as an unhandled promise rejection; the chain is also reset so a single bad
   * message cannot poison every subsequent one.
   */
  private enqueueInbound(work: () => Promise<void>): void {
    this.inbound = this.inbound.then(work, work).catch((error: unknown) => {
      this.lastInboundError = error;
      this.setStatus('error');
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

    if (message.type === 'presence') {
      this.onPresence?.(message.participants);
      return;
    }

    if (message.type === 'sync') {
      this.setStatus('syncing');

      if (message.snapshotBootstrap) {
        const installed = await this.installSnapshotBootstrap(
          message.snapshotBootstrap,
          message.operations,
          message.latestServerSeq,
        );

        if (!installed) {
          return;
        }
      } else {
        await this.onServerOperations(message.operations, message.latestServerSeq);
      }

      this.catchUpComplete = true;
      this.reconnectAttempt = 0;
      this.noteConnectionSuccess();
      this.onServerSeqChange?.(message.latestServerSeq);
      this.telemetry?.emit({
        stage: 'server-log',
        documentId: this.documentId,
        message:
          message.operations.length > 0
            ? `Caught up on ${String(message.operations.length)} server operation(s).`
            : 'Caught up with the server log.',
        serverSeq: message.latestServerSeq,
      });
      await this.flushOutbox();
      await this.refreshOnlineStatus();
      return;
    }

    const ownEcho = message.operation.clientId === this.clientId;

    this.telemetry?.emit({
      stage: ownEcho ? 'ack' : 'server-log',
      documentId: this.documentId,
      message: ownEcho
        ? 'Server echo acknowledged a local operation.'
        : 'Received a remote operation from the server log.',
      serverSeq: message.serverSeq,
    });

    await this.onServerOperations(
      [
        {
          serverSeq: message.serverSeq,
          operation: message.operation,
        },
      ],
      message.serverSeq,
    );
    this.onServerSeqChange?.(message.serverSeq);
    await this.refreshOnlineStatus();
  }

  private async installSnapshotBootstrap(
    bootstrap: SnapshotBootstrap,
    sequencedOperations: readonly SequencedOperation[],
    confirmedThroughServerSeq: number,
  ): Promise<boolean> {
    if (!this.onSnapshotBootstrap) {
      this.fallbackToFullHistorySync();
      return false;
    }

    try {
      await this.onSnapshotBootstrap(bootstrap, sequencedOperations, confirmedThroughServerSeq);
      return true;
    } catch (error) {
      if (
        error instanceof SnapshotBootstrapIneligibleError ||
        error instanceof InvalidSnapshotBootstrapError
      ) {
        this.fallbackToFullHistorySync();
        return false;
      }

      throw error;
    }
  }

  private fallbackToFullHistorySync(): void {
    this.snapshotBootstrapDisabled = true;
    this.catchUpComplete = false;
    this.setStatus('connecting');
    this.socket?.close();
  }

  private async flushOutbox(): Promise<void> {
    if (!this.catchUpComplete || this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    const pending = await this.loadPendingOperations();

    if (pending.length === 0) {
      return;
    }

    this.telemetry?.emit({
      stage: 'outbox',
      documentId: this.documentId,
      message: `Draining ${String(pending.length)} queued operation(s) from the durable outbox.`,
      count: pending.length,
    });
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
      if (this.status !== 'online') {
        this.telemetry?.emit({
          stage: 'converged',
          documentId: this.documentId,
          message: 'Outbox empty. This replica matches the server log.',
          count: 0,
        });
      }

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

    this.telemetry?.emit({
      stage: 'websocket',
      documentId: this.documentId,
      message: `Submitted ${String(operations.length)} operation(s) over /sync.`,
      count: operations.length,
    });
  }

  private scheduleReconnect(): void {
    if (
      this.closedByClient ||
      this.suspended ||
      this.unreachable ||
      this.reconnectTimer !== null ||
      this.socket
    ) {
      return;
    }

    const cappedIndex = Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    const delayMs = RECONNECT_DELAYS_MS[cappedIndex] ?? 4000;
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (this.closedByClient || this.suspended || this.socket) {
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

  private noteConnectionFailure(): void {
    if (this.closedByClient || this.suspended) {
      return;
    }

    this.consecutiveFailures += 1;

    if (this.consecutiveFailures < UNREACHABLE_AFTER_ATTEMPTS || this.unreachable) {
      return;
    }

    this.unreachable = true;
    this.cancelReconnect();
    this.onUnreachableChange?.(true);
  }

  private noteConnectionSuccess(): void {
    this.consecutiveFailures = 0;

    if (!this.unreachable) {
      return;
    }

    this.unreachable = false;
    this.onUnreachableChange?.(false);
  }

  private setStatus(status: SyncStatus): void {
    if (this.status === status) {
      return;
    }

    this.status = status;
    this.onStatusChange?.(status);
  }
}

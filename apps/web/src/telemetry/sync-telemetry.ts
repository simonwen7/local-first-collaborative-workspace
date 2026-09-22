/**
 * Instrumentation for the local-first pipeline.
 *
 * Every event published here is emitted from a real persistence or
 * synchronization code path. Nothing on this bus is simulated or timer-driven,
 * so the UI can visualize genuine system activity rather than an animation
 * script.
 */

export type PipelineStage =
  'local-edit' | 'indexeddb' | 'outbox' | 'websocket' | 'server-log' | 'ack' | 'converged';

export const PIPELINE_STAGES: readonly PipelineStage[] = [
  'local-edit',
  'indexeddb',
  'outbox',
  'websocket',
  'server-log',
  'ack',
  'converged',
];

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  'local-edit': 'Local edit',
  indexeddb: 'IndexedDB',
  outbox: 'Outbox',
  websocket: 'WebSocket',
  'server-log': 'Server log',
  ack: 'Acknowledged',
  converged: 'Converged',
};

export const PIPELINE_STAGE_DETAILS: Record<PipelineStage, string> = {
  'local-edit': 'Keystrokes are diffed into grapheme-level CRDT operations.',
  indexeddb: 'Operations are written durably before any network attempt.',
  outbox: 'Unacknowledged operations are queued for at-least-once delivery.',
  websocket: 'Queued operations are submitted over the /sync socket.',
  'server-log': 'SQLite assigns a monotonic server sequence and persists.',
  ack: 'The sender echo confirms the durable write landed.',
  converged: 'Outbox empty; this replica matches the server log.',
};

export interface SyncTelemetryEvent {
  readonly id: number;
  readonly stage: PipelineStage;
  readonly at: number;
  readonly documentId: string;
  readonly message: string;
  readonly count?: number;
  readonly serverSeq?: number;
}

export interface SyncTelemetryEventInput {
  readonly stage: PipelineStage;
  readonly documentId: string;
  readonly message: string;
  readonly count?: number;
  readonly serverSeq?: number;
}

export type SyncTelemetryListener = (event: SyncTelemetryEvent) => void;

export class SyncTelemetry {
  private nextId = 1;
  private readonly listeners = new Set<SyncTelemetryListener>();

  emit(input: SyncTelemetryEventInput): void {
    const event: SyncTelemetryEvent = {
      id: this.nextId,
      at: Date.now(),
      stage: input.stage,
      documentId: input.documentId,
      message: input.message,
      ...(input.count !== undefined ? { count: input.count } : {}),
      ...(input.serverSeq !== undefined ? { serverSeq: input.serverSeq } : {}),
    };

    this.nextId += 1;

    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  subscribe(listener: SyncTelemetryListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.listeners.clear();
  }
}

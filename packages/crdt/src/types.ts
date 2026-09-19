export const ROOT_ID = 'ROOT' as const;

export type RootId = typeof ROOT_ID;
export type ClientId = string;
export type OperationId = string;
export type ElementId = OperationId;
export type AnchorId = ElementId | RootId;

export interface InsertOperation {
  readonly kind: 'insert';
  readonly opId: OperationId;
  readonly clientId: ClientId;
  readonly counter: number;
  readonly lamport: number;
  readonly afterId: AnchorId;
  readonly value: string;
}

export interface DeleteOperation {
  readonly kind: 'delete';
  readonly opId: OperationId;
  readonly clientId: ClientId;
  readonly counter: number;
  readonly lamport: number;
  readonly targetId: ElementId;
}

export type TextOperation = InsertOperation | DeleteOperation;

export interface VisibleElement {
  readonly id: ElementId;
  readonly value: string;
}

export type ApplyStatus = 'applied' | 'pending' | 'duplicate';

export interface ApplyResult {
  readonly status: ApplyStatus;
}

export interface TextReplicaSnapshotNode {
  readonly id: ElementId;
  readonly afterId: AnchorId;
  readonly value: string;
  readonly clientId: ClientId;
  readonly counter: number;
  readonly lamport: number;
  readonly tombstone: boolean;
}

export interface TextReplicaSnapshot {
  readonly version: 1;
  readonly nodes: TextReplicaSnapshotNode[];
  readonly deleteOperations: DeleteOperation[];
}

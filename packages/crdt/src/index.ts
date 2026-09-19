export {
  InvalidOperationError,
  InvalidReplicaSnapshotError,
  OperationDependencyCycleError,
  OperationIdentityConflictError,
  UnresolvedReplicaSnapshotError,
} from './errors.js';

export {
  createDeleteOperation,
  createInsertOperation,
  makeOperationId,
  operationsEqual,
  validateOperation,
} from './operation.js';

export { TextReplica } from './replica.js';

export { ROOT_ID } from './types.js';

export type {
  AnchorId,
  ApplyResult,
  ApplyStatus,
  ClientId,
  DeleteOperation,
  ElementId,
  InsertOperation,
  OperationId,
  RootId,
  TextOperation,
  TextReplicaSnapshot,
  TextReplicaSnapshotNode,
  VisibleElement,
} from './types.js';

export type { DeleteOperationInput, InsertOperationInput } from './operation.js';

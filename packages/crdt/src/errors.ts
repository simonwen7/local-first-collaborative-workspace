export class InvalidOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOperationError';
  }
}

export class OperationIdentityConflictError extends Error {
  constructor(operationId: string) {
    super(`Operation identity conflict for "${operationId}".`);
    this.name = 'OperationIdentityConflictError';
  }
}

export class OperationDependencyCycleError extends Error {
  constructor(operationId: string) {
    super(`Operation "${operationId}" introduces a dependency cycle.`);
    this.name = 'OperationDependencyCycleError';
  }
}

export class InvalidReplicaSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReplicaSnapshotError';
  }
}

export class UnresolvedReplicaSnapshotError extends Error {
  constructor(operationIds: readonly string[]) {
    super(
      `Cannot export a snapshot while operations remain unresolved: ${operationIds.join(', ')}`,
    );
    this.name = 'UnresolvedReplicaSnapshotError';
  }
}

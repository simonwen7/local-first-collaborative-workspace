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

import { InvalidOperationError } from './errors.js';
import { ROOT_ID } from './types.js';
import type {
  AnchorId,
  ClientId,
  DeleteOperation,
  ElementId,
  InsertOperation,
  OperationId,
  TextOperation,
} from './types.js';

export interface InsertOperationInput {
  readonly clientId: ClientId;
  readonly counter: number;
  readonly lamport: number;
  readonly afterId: AnchorId;
  readonly value: string;
}

export interface DeleteOperationInput {
  readonly clientId: ClientId;
  readonly counter: number;
  readonly lamport: number;
  readonly targetId: ElementId;
}

export function makeOperationId(clientId: ClientId, counter: number): OperationId {
  return `${clientId}:${counter}`;
}

export function createInsertOperation(input: InsertOperationInput): InsertOperation {
  const operation: InsertOperation = {
    kind: 'insert',
    opId: makeOperationId(input.clientId, input.counter),
    clientId: input.clientId,
    counter: input.counter,
    lamport: input.lamport,
    afterId: input.afterId,
    value: input.value,
  };

  validateOperation(operation);
  return operation;
}

export function createDeleteOperation(input: DeleteOperationInput): DeleteOperation {
  const operation: DeleteOperation = {
    kind: 'delete',
    opId: makeOperationId(input.clientId, input.counter),
    clientId: input.clientId,
    counter: input.counter,
    lamport: input.lamport,
    targetId: input.targetId,
  };

  validateOperation(operation);
  return operation;
}

export function validateOperation(operation: TextOperation): void {
  if (operation.clientId.trim().length === 0) {
    throw new InvalidOperationError('clientId must not be empty.');
  }

  if (!Number.isSafeInteger(operation.counter) || operation.counter < 1) {
    throw new InvalidOperationError('counter must be a positive safe integer.');
  }

  if (!Number.isSafeInteger(operation.lamport) || operation.lamport < 1) {
    throw new InvalidOperationError('lamport must be a positive safe integer.');
  }

  if (operation.opId !== makeOperationId(operation.clientId, operation.counter)) {
    throw new InvalidOperationError('opId must equal clientId + counter.');
  }

  if (operation.kind === 'insert') {
    if (operation.value.length === 0) {
      throw new InvalidOperationError('insert value must not be empty.');
    }

    if (operation.afterId === operation.opId) {
      throw new InvalidOperationError('an insert cannot reference itself as its anchor.');
    }

    return;
  }

  if (operation.targetId === ROOT_ID) {
    throw new InvalidOperationError('ROOT cannot be deleted.');
  }
}

export function operationsEqual(left: TextOperation, right: TextOperation): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  if (
    left.opId !== right.opId ||
    left.clientId !== right.clientId ||
    left.counter !== right.counter ||
    left.lamport !== right.lamport
  ) {
    return false;
  }

  if (left.kind === 'insert' && right.kind === 'insert') {
    return left.afterId === right.afterId && left.value === right.value;
  }

  if (left.kind === 'delete' && right.kind === 'delete') {
    return left.targetId === right.targetId;
  }

  return false;
}

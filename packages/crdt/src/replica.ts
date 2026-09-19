import {
  InvalidOperationError,
  OperationDependencyCycleError,
  OperationIdentityConflictError,
} from './errors.js';
import { operationsEqual, validateOperation } from './operation.js';
import { ROOT_ID } from './types.js';
import type {
  AnchorId,
  ApplyResult,
  DeleteOperation,
  ElementId,
  InsertOperation,
  OperationId,
  TextOperation,
  VisibleElement,
} from './types.js';

interface TextNode {
  readonly id: ElementId;
  readonly afterId: AnchorId;
  readonly value: string;
  readonly clientId: string;
  readonly counter: number;
  readonly lamport: number;
  tombstone: boolean;
}

export class TextReplica {
  private readonly nodes = new Map<ElementId, TextNode>();
  private readonly childrenByParent = new Map<AnchorId, ElementId[]>();
  private readonly knownOperations = new Map<OperationId, TextOperation>();
  private readonly pendingInsertsByAnchor = new Map<ElementId, Set<OperationId>>();
  private readonly pendingDeletesByTarget = new Map<ElementId, Set<OperationId>>();

  apply(operation: TextOperation): ApplyResult {
    validateOperation(operation);

    const known = this.knownOperations.get(operation.opId);

    if (known) {
      if (!operationsEqual(known, operation)) {
        throw new OperationIdentityConflictError(operation.opId);
      }

      return { status: 'duplicate' };
    }

    if (operation.kind === 'insert') {
      this.assertInsertDoesNotCreateCycle(operation);
    }

    if (operation.kind === 'delete' && this.pendingInsertsByAnchor.has(operation.opId)) {
      throw new InvalidOperationError(
        `Element dependency "${operation.opId}" resolved to a delete operation instead of an insert.`,
      );
    }

    this.knownOperations.set(operation.opId, operation);

    if (operation.kind === 'insert') {
      return this.applyInsert(operation);
    }

    return this.applyDelete(operation);
  }

  applyAll(operations: Iterable<TextOperation>): void {
    for (const operation of operations) {
      this.apply(operation);
    }
  }

  materialize(): string {
    return this.getVisibleElements()
      .map((element) => element.value)
      .join('');
  }

  getVisibleElements(): VisibleElement[] {
    const output: VisibleElement[] = [];
    const rootChildren = this.childrenByParent.get(ROOT_ID) ?? [];
    const stack: ElementId[] = [...rootChildren].reverse();

    while (stack.length > 0) {
      const currentId = stack.pop();

      if (!currentId) {
        continue;
      }

      const node = this.nodes.get(currentId);

      if (!node) {
        throw new InvalidOperationError(
          `Replica structure references missing node "${currentId}".`,
        );
      }

      if (!node.tombstone) {
        output.push({
          id: node.id,
          value: node.value,
        });
      }

      const children = this.childrenByParent.get(node.id) ?? [];

      for (let index = children.length - 1; index >= 0; index -= 1) {
        const childId = children[index];

        if (childId) {
          stack.push(childId);
        }
      }
    }

    return output;
  }

  getKnownOperationCount(): number {
    return this.knownOperations.size;
  }

  getUnresolvedOperationIds(): OperationId[] {
    const unresolved = new Set<OperationId>();

    for (const operationIds of this.pendingInsertsByAnchor.values()) {
      for (const operationId of operationIds) {
        unresolved.add(operationId);
      }
    }

    for (const operationIds of this.pendingDeletesByTarget.values()) {
      for (const operationId of operationIds) {
        unresolved.add(operationId);
      }
    }

    return [...unresolved].sort();
  }

  private applyInsert(operation: InsertOperation): ApplyResult {
    if (!this.anchorExists(operation.afterId)) {
      this.addPending(this.pendingInsertsByAnchor, operation.afterId as ElementId, operation.opId);

      return { status: 'pending' };
    }

    this.attachInsertAndResolve(operation);
    return { status: 'applied' };
  }

  private applyDelete(operation: DeleteOperation): ApplyResult {
    const target = this.nodes.get(operation.targetId);

    if (!target) {
      this.addPending(this.pendingDeletesByTarget, operation.targetId, operation.opId);

      return { status: 'pending' };
    }

    target.tombstone = true;
    return { status: 'applied' };
  }

  private attachInsertAndResolve(initialOperation: InsertOperation): void {
    const queue: InsertOperation[] = [initialOperation];

    while (queue.length > 0) {
      const operation = queue.shift();

      if (!operation) {
        continue;
      }

      if (this.nodes.has(operation.opId)) {
        continue;
      }

      if (!this.anchorExists(operation.afterId)) {
        this.addPending(
          this.pendingInsertsByAnchor,
          operation.afterId as ElementId,
          operation.opId,
        );
        continue;
      }

      const node: TextNode = {
        id: operation.opId,
        afterId: operation.afterId,
        value: operation.value,
        clientId: operation.clientId,
        counter: operation.counter,
        lamport: operation.lamport,
        tombstone: false,
      };

      this.nodes.set(node.id, node);
      this.insertChild(node.afterId, node);

      const pendingDeletes = this.pendingDeletesByTarget.get(node.id);

      if (pendingDeletes && pendingDeletes.size > 0) {
        node.tombstone = true;
        this.pendingDeletesByTarget.delete(node.id);
      }

      const waitingChildren = this.pendingInsertsByAnchor.get(node.id);

      if (!waitingChildren) {
        continue;
      }

      this.pendingInsertsByAnchor.delete(node.id);

      for (const childOperationId of waitingChildren) {
        const childOperation = this.knownOperations.get(childOperationId);

        if (!childOperation || childOperation.kind !== 'insert') {
          throw new InvalidOperationError(
            `Pending insert "${childOperationId}" does not resolve to an insert operation.`,
          );
        }

        queue.push(childOperation);
      }
    }
  }

  private insertChild(parentId: AnchorId, node: TextNode): void {
    const siblings = this.childrenByParent.get(parentId) ?? [];
    let insertionIndex = siblings.length;

    for (let index = 0; index < siblings.length; index += 1) {
      const existingId = siblings[index];

      if (!existingId) {
        continue;
      }

      const existingNode = this.nodes.get(existingId);

      if (!existingNode) {
        throw new InvalidOperationError(
          `Replica structure references missing sibling "${existingId}".`,
        );
      }

      if (compareNodes(node, existingNode) < 0) {
        insertionIndex = index;
        break;
      }
    }

    siblings.splice(insertionIndex, 0, node.id);
    this.childrenByParent.set(parentId, siblings);
  }

  private assertInsertDoesNotCreateCycle(operation: InsertOperation): void {
    let cursor: AnchorId = operation.afterId;
    const visited = new Set<ElementId>();

    while (cursor !== ROOT_ID) {
      if (cursor === operation.opId) {
        throw new OperationDependencyCycleError(operation.opId);
      }

      if (visited.has(cursor)) {
        throw new OperationDependencyCycleError(operation.opId);
      }

      visited.add(cursor);

      const dependency = this.knownOperations.get(cursor);

      if (!dependency) {
        return;
      }

      if (dependency.kind !== 'insert') {
        throw new InvalidOperationError(
          `Insert anchor "${cursor}" resolves to a non-insert operation.`,
        );
      }

      cursor = dependency.afterId;
    }
  }

  private anchorExists(anchorId: AnchorId): boolean {
    return anchorId === ROOT_ID || this.nodes.has(anchorId);
  }

  private addPending(
    map: Map<ElementId, Set<OperationId>>,
    dependencyId: ElementId,
    operationId: OperationId,
  ): void {
    const operations = map.get(dependencyId) ?? new Set<OperationId>();
    operations.add(operationId);
    map.set(dependencyId, operations);
  }
}

function compareNodes(left: TextNode, right: TextNode): number {
  if (left.lamport !== right.lamport) {
    return left.lamport > right.lamport ? -1 : 1;
  }

  if (left.clientId !== right.clientId) {
    return left.clientId < right.clientId ? -1 : 1;
  }

  if (left.counter !== right.counter) {
    return left.counter < right.counter ? -1 : 1;
  }

  return 0;
}

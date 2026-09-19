import {
  InvalidOperationError,
  InvalidReplicaSnapshotError,
  OperationDependencyCycleError,
  OperationIdentityConflictError,
  UnresolvedReplicaSnapshotError,
} from './errors.js';
import { makeOperationId, operationsEqual, validateOperation } from './operation.js';
import { ROOT_ID } from './types.js';
import type {
  AnchorId,
  ApplyResult,
  DeleteOperation,
  ElementId,
  InsertOperation,
  OperationId,
  TextOperation,
  TextReplicaSnapshot,
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

    if (operation.kind === 'insert' && !this.anchorExists(operation.afterId)) {
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

  getKnownOperationIds(): OperationId[] {
    return [...this.knownOperations.keys()].sort(compareCodeUnits);
  }

  exportSnapshot(): TextReplicaSnapshot {
    const unresolved = this.getUnresolvedOperationIds();

    if (unresolved.length > 0) {
      throw new UnresolvedReplicaSnapshotError(unresolved);
    }

    const nodes = [...this.nodes.values()]
      .map((node) => cloneSnapshotNode(node))
      .sort((left, right) => compareCodeUnits(left.id, right.id));

    const deleteOperations = [...this.knownOperations.values()]
      .filter((operation): operation is DeleteOperation => operation.kind === 'delete')
      .map((operation) => cloneDeleteOperation(operation))
      .sort((left, right) => compareCodeUnits(left.opId, right.opId));

    return {
      version: 1,
      nodes,
      deleteOperations,
    };
  }

  static fromSnapshot(snapshot: TextReplicaSnapshot): TextReplica {
    const replica = new TextReplica();
    replica.restoreFromSnapshot(snapshot);
    return replica;
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

  private restoreFromSnapshot(snapshot: TextReplicaSnapshot): void {
    validateSnapshotShape(snapshot);

    const nodeIds = new Set<ElementId>();
    const knownOperations = new Map<OperationId, TextOperation>();
    const nodes = new Map<ElementId, TextNode>();
    const deletedTargets = new Set<ElementId>();

    for (const rawNode of snapshot.nodes) {
      const node = cloneSnapshotNode(rawNode);

      if (node.id === ROOT_ID) {
        throw new InvalidReplicaSnapshotError('ROOT cannot be used as an inserted node id.');
      }

      if (nodeIds.has(node.id)) {
        throw new InvalidReplicaSnapshotError(`Duplicate snapshot node id "${node.id}".`);
      }

      if (node.id !== makeOperationId(node.clientId, node.counter)) {
        throw new InvalidReplicaSnapshotError(
          `Snapshot node id "${node.id}" does not match clientId and counter.`,
        );
      }

      const insertOperation: InsertOperation = {
        kind: 'insert',
        opId: node.id,
        clientId: node.clientId,
        counter: node.counter,
        lamport: node.lamport,
        afterId: node.afterId,
        value: node.value,
      };

      try {
        validateOperation(insertOperation);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid insert operation.';
        throw new InvalidReplicaSnapshotError(message);
      }

      nodeIds.add(node.id);
      knownOperations.set(insertOperation.opId, insertOperation);
      nodes.set(node.id, {
        id: node.id,
        afterId: node.afterId,
        value: node.value,
        clientId: node.clientId,
        counter: node.counter,
        lamport: node.lamport,
        tombstone: node.tombstone,
      });
    }

    for (const rawDelete of snapshot.deleteOperations) {
      const operation = cloneDeleteOperation(rawDelete);

      try {
        validateOperation(operation);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid delete operation.';
        throw new InvalidReplicaSnapshotError(message);
      }

      const existing = knownOperations.get(operation.opId);

      if (existing) {
        if (!operationsEqual(existing, operation)) {
          throw new OperationIdentityConflictError(operation.opId);
        }

        throw new InvalidReplicaSnapshotError(
          `Duplicate snapshot operation identity "${operation.opId}".`,
        );
      }

      if (!nodes.has(operation.targetId)) {
        throw new InvalidReplicaSnapshotError(
          `Delete operation "${operation.opId}" targets missing node "${operation.targetId}".`,
        );
      }

      knownOperations.set(operation.opId, operation);
      deletedTargets.add(operation.targetId);
    }

    for (const node of nodes.values()) {
      if (node.afterId !== ROOT_ID && !nodes.has(node.afterId)) {
        throw new InvalidReplicaSnapshotError(
          `Snapshot node "${node.id}" references missing anchor "${node.afterId}".`,
        );
      }

      if (node.tombstone && !deletedTargets.has(node.id)) {
        throw new InvalidReplicaSnapshotError(
          `Snapshot node "${node.id}" is tombstoned without a known delete.`,
        );
      }

      if (!node.tombstone && deletedTargets.has(node.id)) {
        throw new InvalidReplicaSnapshotError(
          `Snapshot node "${node.id}" is visible but targeted by a known delete.`,
        );
      }
    }

    assertSnapshotGraphIsAcyclic(nodes);

    const childrenByParent = new Map<AnchorId, ElementId[]>();

    for (const node of nodes.values()) {
      const siblings = childrenByParent.get(node.afterId) ?? [];
      siblings.push(node.id);
      childrenByParent.set(node.afterId, siblings);
    }

    for (const [parentId, siblings] of childrenByParent) {
      siblings.sort((leftId, rightId) => {
        const left = nodes.get(leftId);
        const right = nodes.get(rightId);

        if (!left || !right) {
          throw new InvalidReplicaSnapshotError('Snapshot sibling list references a missing node.');
        }

        return compareNodes(left, right);
      });
      childrenByParent.set(parentId, siblings);
    }

    this.nodes.clear();
    this.childrenByParent.clear();
    this.knownOperations.clear();
    this.pendingInsertsByAnchor.clear();
    this.pendingDeletesByTarget.clear();

    for (const [id, node] of nodes) {
      this.nodes.set(id, node);
    }

    for (const [parentId, siblings] of childrenByParent) {
      this.childrenByParent.set(parentId, siblings);
    }

    for (const [opId, operation] of knownOperations) {
      this.knownOperations.set(opId, operation);
    }
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

function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function cloneSnapshotNode(node: {
  readonly id: ElementId;
  readonly afterId: AnchorId;
  readonly value: string;
  readonly clientId: string;
  readonly counter: number;
  readonly lamport: number;
  readonly tombstone: boolean;
}): TextReplicaSnapshot['nodes'][number] {
  return {
    id: node.id,
    afterId: node.afterId,
    value: node.value,
    clientId: node.clientId,
    counter: node.counter,
    lamport: node.lamport,
    tombstone: node.tombstone,
  };
}

function cloneDeleteOperation(operation: DeleteOperation): DeleteOperation {
  return {
    kind: 'delete',
    opId: operation.opId,
    clientId: operation.clientId,
    counter: operation.counter,
    lamport: operation.lamport,
    targetId: operation.targetId,
  };
}

function validateSnapshotShape(snapshot: TextReplicaSnapshot): void {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new InvalidReplicaSnapshotError('Snapshot must be an object.');
  }

  if (snapshot.version !== 1) {
    throw new InvalidReplicaSnapshotError(
      `Unsupported snapshot version "${String(snapshot.version)}".`,
    );
  }

  if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.deleteOperations)) {
    throw new InvalidReplicaSnapshotError('Snapshot nodes and deleteOperations must be arrays.');
  }

  for (const node of snapshot.nodes) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      throw new InvalidReplicaSnapshotError('Snapshot node must be an object.');
    }

    if (
      typeof node.id !== 'string' ||
      typeof node.afterId !== 'string' ||
      typeof node.value !== 'string' ||
      typeof node.clientId !== 'string' ||
      typeof node.counter !== 'number' ||
      typeof node.lamport !== 'number' ||
      typeof node.tombstone !== 'boolean'
    ) {
      throw new InvalidReplicaSnapshotError('Snapshot node fields are malformed.');
    }
  }

  for (const operation of snapshot.deleteOperations) {
    if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new InvalidReplicaSnapshotError('Snapshot delete operation must be an object.');
    }
  }
}

function assertSnapshotGraphIsAcyclic(nodes: Map<ElementId, TextNode>): void {
  const color = new Map<ElementId, 'gray' | 'black'>();

  for (const startId of nodes.keys()) {
    if (color.get(startId) === 'black') {
      continue;
    }

    const stack: ElementId[] = [];
    let cursor: AnchorId = startId;

    while (cursor !== ROOT_ID) {
      const state = color.get(cursor);

      if (state === 'black') {
        break;
      }

      if (state === 'gray') {
        throw new InvalidReplicaSnapshotError(`Snapshot graph contains a cycle at "${cursor}".`);
      }

      const node = nodes.get(cursor);

      if (!node) {
        throw new InvalidReplicaSnapshotError(
          `Snapshot graph references missing node "${cursor}".`,
        );
      }

      color.set(cursor, 'gray');
      stack.push(cursor);
      cursor = node.afterId;

      if (cursor !== ROOT_ID && !nodes.has(cursor)) {
        throw new InvalidReplicaSnapshotError(
          `Snapshot node references missing non-ROOT anchor "${cursor}".`,
        );
      }
    }

    for (const id of stack) {
      color.set(id, 'black');
    }
  }
}

import { describe, expect, it } from 'vitest';
import {
  ROOT_ID,
  OperationDependencyCycleError,
  OperationIdentityConflictError,
  TextReplica,
  createDeleteOperation,
  createInsertOperation,
} from '../src/index.js';
import type { AnchorId, InsertOperation } from '../src/index.js';

function insert(
  clientId: string,
  counter: number,
  lamport: number,
  afterId: AnchorId,
  value: string,
): InsertOperation {
  return createInsertOperation({
    clientId,
    counter,
    lamport,
    afterId,
    value,
  });
}

describe('TextReplica', () => {
  it('applies sequential inserts after already-attached anchors', () => {
    const replica = new TextReplica();
    const first = insert('alice', 1, 1, ROOT_ID, 'A');
    const second = insert('alice', 2, 2, first.opId, 'B');

    expect(replica.apply(first).status).toBe('applied');
    expect(replica.apply(second).status).toBe('applied');
    expect(replica.materialize()).toBe('AB');
    expect(replica.getUnresolvedOperationIds()).toEqual([]);
  });

  it('materializes a sequential insert chain', () => {
    const replica = new TextReplica();

    const h = insert('alice', 1, 1, ROOT_ID, 'H');
    const i = insert('alice', 2, 2, h.opId, 'i');

    replica.apply(h);
    replica.apply(i);

    expect(replica.materialize()).toBe('Hi');
    expect(replica.getUnresolvedOperationIds()).toEqual([]);
  });

  it('orders concurrent same-anchor inserts deterministically', () => {
    const alice = insert('alice', 1, 10, ROOT_ID, 'A');
    const bob = insert('bob', 1, 10, ROOT_ID, 'B');

    const first = new TextReplica();
    first.apply(alice);
    first.apply(bob);

    const second = new TextReplica();
    second.apply(bob);
    second.apply(alice);

    expect(first.materialize()).toBe(second.materialize());
    expect(first.materialize()).toBe('AB');
  });

  it('places a causally newer same-anchor insert nearer the anchor', () => {
    const older = insert('alice', 1, 10, ROOT_ID, 'X');
    const newer = insert('alice', 2, 11, ROOT_ID, 'Y');

    const replica = new TextReplica();
    replica.apply(older);
    replica.apply(newer);

    expect(replica.materialize()).toBe('YX');
  });

  it('keeps descendants visible when their parent is tombstoned', () => {
    const a = insert('alice', 1, 1, ROOT_ID, 'A');
    const b = insert('alice', 2, 2, a.opId, 'B');
    const x = insert('bob', 1, 3, b.opId, 'X');

    const replica = new TextReplica();
    replica.apply(a);
    replica.apply(b);
    replica.apply(x);
    replica.apply(
      createDeleteOperation({
        clientId: 'alice',
        counter: 3,
        lamport: 4,
        targetId: b.opId,
      }),
    );

    expect(replica.materialize()).toBe('AX');
  });

  it('handles delete-before-insert delivery', () => {
    const target = insert('alice', 1, 1, ROOT_ID, 'X');
    const deletion = createDeleteOperation({
      clientId: 'bob',
      counter: 1,
      lamport: 2,
      targetId: target.opId,
    });

    const replica = new TextReplica();

    expect(replica.apply(deletion).status).toBe('pending');
    expect(replica.apply(target).status).toBe('applied');
    expect(replica.materialize()).toBe('');
    expect(replica.getUnresolvedOperationIds()).toEqual([]);
  });

  it('resolves an insert dependency chain delivered in reverse', () => {
    const a = insert('alice', 1, 1, ROOT_ID, 'A');
    const b = insert('alice', 2, 2, a.opId, 'B');
    const c = insert('alice', 3, 3, b.opId, 'C');

    const replica = new TextReplica();

    replica.apply(c);
    replica.apply(b);

    expect(replica.getUnresolvedOperationIds()).toEqual(['alice:2', 'alice:3']);

    replica.apply(a);

    expect(replica.materialize()).toBe('ABC');
    expect(replica.getUnresolvedOperationIds()).toEqual([]);
  });

  it('treats the same operation delivered twice as a no-op duplicate', () => {
    const operation = insert('alice', 1, 1, ROOT_ID, 'A');
    const replica = new TextReplica();

    expect(replica.apply(operation).status).toBe('applied');
    expect(replica.apply(operation).status).toBe('duplicate');
    expect(replica.materialize()).toBe('A');
    expect(replica.getKnownOperationCount()).toBe(1);
  });

  it('rejects one operation identity carrying different facts', () => {
    const first = insert('alice', 1, 1, ROOT_ID, 'A');
    const conflicting = {
      ...first,
      value: 'B',
    };

    const replica = new TextReplica();
    replica.apply(first);

    expect(() => replica.apply(conflicting)).toThrow(OperationIdentityConflictError);
  });

  it('rejects a pending dependency cycle', () => {
    const a = insert('alice', 1, 1, 'bob:1', 'A');
    const b = insert('bob', 1, 1, 'alice:1', 'B');

    const replica = new TextReplica();
    expect(replica.apply(a).status).toBe('pending');

    expect(() => replica.apply(b)).toThrow(OperationDependencyCycleError);
  });

  it('rejects a longer pending dependency cycle', () => {
    const a = insert('alice', 1, 1, 'carol:1', 'A');
    const b = insert('bob', 1, 2, 'alice:1', 'B');
    const c = insert('carol', 1, 3, 'bob:1', 'C');

    const replica = new TextReplica();
    expect(replica.apply(a).status).toBe('pending');
    expect(replica.apply(b).status).toBe('pending');

    expect(() => replica.apply(c)).toThrow(OperationDependencyCycleError);
  });

  it('uses locale-independent code-unit ordering for tied client IDs', () => {
    const upper = insert('Z', 1, 10, ROOT_ID, 'Z');
    const lower = insert('a', 1, 10, ROOT_ID, 'a');

    const first = new TextReplica();
    first.apply(lower);
    first.apply(upper);

    const second = new TextReplica();
    second.apply(upper);
    second.apply(lower);

    expect(first.materialize()).toBe('Za');
    expect(second.materialize()).toBe('Za');
  });
});

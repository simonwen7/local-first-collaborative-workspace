import { describe, expect, it } from 'vitest';
import {
  InvalidReplicaSnapshotError,
  OperationIdentityConflictError,
  ROOT_ID,
  TextReplica,
  UnresolvedReplicaSnapshotError,
  createDeleteOperation,
  createInsertOperation,
} from '../src/index.js';
import type { TextReplicaSnapshot } from '../src/index.js';

function insert(
  clientId: string,
  counter: number,
  lamport: number,
  afterId: string,
  value: string,
) {
  return createInsertOperation({
    clientId,
    counter,
    lamport,
    afterId,
    value,
  });
}

describe('TextReplica snapshots', () => {
  it('export/import preserves materialized text and visible ids', () => {
    const replica = new TextReplica();
    const a = insert('alice', 1, 1, ROOT_ID, 'A');
    const b = insert('alice', 2, 2, a.opId, 'B');
    replica.apply(a);
    replica.apply(b);

    const restored = TextReplica.fromSnapshot(replica.exportSnapshot());

    expect(restored.materialize()).toBe('AB');
    expect(restored.getVisibleElements()).toEqual(replica.getVisibleElements());
    expect(restored.getKnownOperationIds()).toEqual(replica.getKnownOperationIds());
  });

  it('JSON stringify/parse round-trip restores correctly', () => {
    const replica = new TextReplica();
    replica.apply(insert('alice', 1, 1, ROOT_ID, 'Z'));

    const restored = TextReplica.fromSnapshot(
      JSON.parse(JSON.stringify(replica.exportSnapshot())) as TextReplicaSnapshot,
    );

    expect(restored.materialize()).toBe('Z');
  });

  it('preserves tombstones and descendants, then accepts later ops', () => {
    const replica = new TextReplica();
    const a = insert('alice', 1, 1, ROOT_ID, 'A');
    const b = insert('alice', 2, 2, a.opId, 'B');
    const x = insert('bob', 1, 3, b.opId, 'X');
    const deleteB = createDeleteOperation({
      clientId: 'alice',
      counter: 3,
      lamport: 4,
      targetId: b.opId,
    });

    replica.applyAll([a, b, x, deleteB]);

    const restored = TextReplica.fromSnapshot(replica.exportSnapshot());
    expect(restored.materialize()).toBe('AX');

    const afterTombstone = insert('carol', 1, 10, b.opId, 'Y');
    expect(restored.apply(afterTombstone).status).toBe('applied');
    expect(restored.materialize()).toBe('AYX');

    const deleteA = createDeleteOperation({
      clientId: 'carol',
      counter: 2,
      lamport: 11,
      targetId: a.opId,
    });
    expect(restored.apply(deleteA).status).toBe('applied');
    expect(restored.materialize()).toBe('YX');
  });

  it('treats historical insert and delete redelivery as duplicates', () => {
    const replica = new TextReplica();
    const a = insert('alice', 1, 1, ROOT_ID, 'A');
    const deletion = createDeleteOperation({
      clientId: 'bob',
      counter: 1,
      lamport: 2,
      targetId: a.opId,
    });
    replica.apply(a);
    replica.apply(deletion);

    const restored = TextReplica.fromSnapshot(replica.exportSnapshot());
    expect(restored.apply(a).status).toBe('duplicate');
    expect(restored.apply(deletion).status).toBe('duplicate');
  });

  it('rejects conflicting historical insert and delete identities', () => {
    const replica = new TextReplica();
    const a = insert('alice', 1, 1, ROOT_ID, 'A');
    const deletion = createDeleteOperation({
      clientId: 'bob',
      counter: 1,
      lamport: 2,
      targetId: a.opId,
    });
    replica.apply(a);
    replica.apply(deletion);

    const restored = TextReplica.fromSnapshot(replica.exportSnapshot());

    expect(() =>
      restored.apply({
        ...a,
        value: 'Z',
      }),
    ).toThrow(OperationIdentityConflictError);

    expect(() =>
      restored.apply({
        ...deletion,
        targetId: a.opId,
        lamport: 9,
      }),
    ).toThrow(OperationIdentityConflictError);
  });

  it('snapshot plus later suffix equals a full-log replica', () => {
    const a = insert('alice', 1, 1, ROOT_ID, 'A');
    const b = insert('alice', 2, 2, a.opId, 'B');
    const c = insert('alice', 3, 3, b.opId, 'C');

    const prefix = new TextReplica();
    prefix.applyAll([a, b]);
    const restored = TextReplica.fromSnapshot(prefix.exportSnapshot());
    restored.apply(c);

    const full = new TextReplica();
    full.applyAll([a, b, c]);

    expect(restored.materialize()).toBe(full.materialize());
    expect(restored.getVisibleElements()).toEqual(full.getVisibleElements());
    expect(restored.getKnownOperationIds()).toEqual(full.getKnownOperationIds());
  });

  it('refuses to export while an insert or delete is pending', () => {
    const pendingInsert = new TextReplica();
    pendingInsert.apply(insert('alice', 1, 1, 'missing:1', 'A'));
    expect(() => pendingInsert.exportSnapshot()).toThrow(UnresolvedReplicaSnapshotError);

    const pendingDelete = new TextReplica();
    pendingDelete.apply(
      createDeleteOperation({
        clientId: 'bob',
        counter: 1,
        lamport: 1,
        targetId: 'missing:1',
      }),
    );
    expect(() => pendingDelete.exportSnapshot()).toThrow(UnresolvedReplicaSnapshotError);
  });

  it('rejects missing-anchor, cyclic, inconsistent, duplicate, and version-invalid snapshots', () => {
    const replica = new TextReplica();
    const a = insert('alice', 1, 1, ROOT_ID, 'A');
    replica.apply(a);
    const valid = replica.exportSnapshot();

    expect(() =>
      TextReplica.fromSnapshot({
        ...valid,
        nodes: [
          {
            ...valid.nodes[0]!,
            afterId: 'missing:1',
          },
        ],
      }),
    ).toThrow(InvalidReplicaSnapshotError);

    expect(() =>
      TextReplica.fromSnapshot({
        version: 1,
        nodes: [
          {
            id: 'alice:1',
            afterId: 'bob:1',
            value: 'A',
            clientId: 'alice',
            counter: 1,
            lamport: 1,
            tombstone: false,
          },
          {
            id: 'bob:1',
            afterId: 'alice:1',
            value: 'B',
            clientId: 'bob',
            counter: 1,
            lamport: 1,
            tombstone: false,
          },
        ],
        deleteOperations: [],
      }),
    ).toThrow(InvalidReplicaSnapshotError);

    expect(() =>
      TextReplica.fromSnapshot({
        ...valid,
        nodes: [
          {
            ...valid.nodes[0]!,
            tombstone: true,
          },
        ],
      }),
    ).toThrow(InvalidReplicaSnapshotError);

    expect(() =>
      TextReplica.fromSnapshot({
        ...valid,
        deleteOperations: [
          createDeleteOperation({
            clientId: 'bob',
            counter: 1,
            lamport: 2,
            targetId: a.opId,
          }),
        ],
      }),
    ).toThrow(InvalidReplicaSnapshotError);

    expect(() =>
      TextReplica.fromSnapshot({
        ...valid,
        nodes: [...valid.nodes, ...valid.nodes],
      }),
    ).toThrow(InvalidReplicaSnapshotError);

    expect(() =>
      TextReplica.fromSnapshot({
        version: 1,
        nodes: valid.nodes,
        deleteOperations: [
          createDeleteOperation({
            clientId: 'alice',
            counter: 1,
            lamport: 2,
            targetId: a.opId,
          }),
        ],
      }),
    ).toThrow(OperationIdentityConflictError);

    expect(() =>
      TextReplica.fromSnapshot({
        version: 2 as unknown as 1,
        nodes: valid.nodes,
        deleteOperations: [],
      }),
    ).toThrow(InvalidReplicaSnapshotError);
  });

  it('exports nodes and deletes in deterministic code-unit order', () => {
    const replica = new TextReplica();
    const z = insert('z', 1, 2, ROOT_ID, 'Z');
    const a = insert('a', 1, 1, ROOT_ID, 'A');
    replica.apply(z);
    replica.apply(a);
    replica.apply(
      createDeleteOperation({
        clientId: 'm',
        counter: 1,
        lamport: 3,
        targetId: z.opId,
      }),
    );
    replica.apply(
      createDeleteOperation({
        clientId: 'b',
        counter: 1,
        lamport: 4,
        targetId: a.opId,
      }),
    );

    const snapshot = replica.exportSnapshot();
    expect(snapshot.nodes.map((node) => node.id)).toEqual(['a:1', 'z:1']);
    expect(snapshot.deleteOperations.map((operation) => operation.opId)).toEqual(['b:1', 'm:1']);
  });
});

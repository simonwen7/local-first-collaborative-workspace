# CRDT Design

## Status

Accepted Milestone 0 design. The CRDT is implemented in later milestones.

## Model

The collaborative text engine is a custom, operation-based, RGA-inspired sequence CRDT.

The initial document model is plain text / paragraph text rather than a rich-text tree.

## Atomic Text Unit

The logical text unit is a Unicode grapheme cluster, not a UTF-16 code unit.

Editor code will later translate browser input and IME composition into complete grapheme-level operations.

## Root

Every replica contains a permanent `ROOT` sentinel.

`ROOT` is not visible and cannot be deleted.

## Insert Identity

For an insert:

insert operation ID = inserted element ID

An inserted element has immutable identity and placement metadata.

## Ordering

Each locally generated operation carries:

- client identity
- client-local counter
- Lamport logical clock

Concurrent siblings use the same deterministic comparator on every replica.

The initial ordering rule is:

1. Lamport clock descending
2. client ID ascending
3. client-local counter ascending

Wall-clock timestamps are not used for CRDT conflict resolution.

## Delete

Deletion is logical.

A deleted element becomes a tombstone instead of being physically removed.

A tombstoned element remains a valid anchor and its descendants continue to participate in deterministic traversal.

## Out-of-Order Delivery

An insert whose anchor is unavailable is retained as pending.

A delete whose target is unavailable is retained as pending.

When the missing dependency arrives, pending operations are reconsidered.

## Duplicate Identity

Same operation ID + identical canonical operation:
duplicate / no-op.

Same operation ID + different canonical operation:
identity corruption and an explicit error.

## Materialization

Visible text is produced by deterministic traversal from `ROOT`.

For every node:

- emit its grapheme if it is not tombstoned
- traverse its deterministically ordered descendants whether or not the node itself is tombstoned

## Convergence Argument

If two replicas eventually contain the same valid operation set, they have:

- the same immutable nodes
- the same parent relationships
- the same deterministic sibling order
- the same tombstone state
- the same traversal algorithm

Therefore they materialize the same visible document.

Arrival order is not part of this result.

## Client Checkpoints

A fully resolved replica can export a version-1 `TextReplica` snapshot: every node including tombstones, plus historical delete operations. Insert operations are reconstructed from node fields. `childrenByParent` and pending maps are not serialized. Unresolved replicas cannot be snapshotted.

`fromSnapshot` rebuilds nodes, `knownOperations`, and child order directly. Sibling groups use the existing comparator. Parent-cycle validation is an O(n)-style iterative walk.

## Sequential Replay

Cycle detection walks pending/missing-anchor chains only. An insert whose anchor already exists in the attached graph cannot create an ancestor cycle involving that new node. Duplicate, identity-conflict, pending, and sibling-order semantics are unchanged.

## Scope Boundaries

Level 2 does not require:

- aggressive tombstone garbage collection
- rich-text CRDT semantics
- distributed undelete
- Google Docs scale

Correctness takes priority over premature optimization.

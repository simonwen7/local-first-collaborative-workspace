# ADR 0001: Custom Sequence CRDT

## Status

Accepted.

## Context

The project must demonstrate real local-first collaboration, offline editing, operation-level synchronization, and deterministic convergence.

The synchronization engine is the primary technical depth of the project.

## Decision

Implement a custom, scope-controlled, RGA-inspired sequence CRDT for collaborative text.

## Alternatives Considered

- Operational Transformation
- Yjs
- Automerge
- server-ordered operations
- whole-document last-write-wins

## Rationale

Yjs and Automerge are mature choices for production collaboration, but using them as the core engine would delegate the project's main synchronization problem to a library.

Operational Transformation adds significant transformation complexity and is less aligned with the project's independent offline replica model.

Whole-document last-write-wins does not satisfy the collaboration requirements.

## Consequences

The project owns CRDT correctness.

This increases implementation and testing burden, particularly around:

- concurrent insert ordering
- insert/delete interaction
- out-of-order operations
- tombstones
- dependency resolution
- convergence

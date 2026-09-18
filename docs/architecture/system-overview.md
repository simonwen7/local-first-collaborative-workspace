# System Overview

## Status

Accepted Milestone 0 architecture. Implementation is incremental and may not yet provide every capability described here.

## Product

Local-First Collaborative Document Workspace is a multi-client document product designed around independent local replicas.

The defining behavior is that a client can continue editing while disconnected, persist those changes locally, reconnect later, exchange missing operations, and converge with other replicas without replacing the entire document using last-write-wins.

## Architecture

The system is divided into four primary boundaries:

1. `@lfcw/crdt`
   - Pure deterministic collaborative text engine.
   - Runtime-neutral.
   - No networking, persistence, UI, or server sequencing.

2. `@lfcw/protocol`
   - Shared wire contracts and runtime validation.
   - Defines communication between browser clients and the server.

3. `apps/web`
   - React product UI.
   - Local replica ownership.
   - IndexedDB persistence.
   - Editor/controller translation.
   - WebSocket sync client.

4. `apps/server`
   - Fastify application.
   - WebSocket synchronization coordinator.
   - Durable SQLite operation storage.
   - Realtime relay.

## Local-First Principle

A local edit does not require the server to be available.

Conceptually:

User input
→ create stable operation
→ durably enqueue locally
→ apply to local replica
→ update UI
→ synchronize when connectivity exists

The server is a durable operation store, realtime relay, and synchronization coordinator. It is not the only copy of the document state.

## Offline Behavior

When disconnected, the client continues to:

- open locally available documents
- create operations
- persist operations
- materialize the local document
- display the updated UI

Reconnect exchanges operations rather than replacing the entire document.

## Shared Package Constraint

`packages/crdt` and `packages/protocol` must remain usable by both browser and Node runtimes.

They must not depend on browser-only or Node-only global APIs unless a future architecture decision explicitly changes this rule.

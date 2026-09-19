# Persistence Model

## Status

Implemented through Milestone 3 for the local-first operation log, outbox, and per-document sync cursor.

## Client Persistence

The browser uses IndexedDB through Dexie (`lfcw-local-workspace`, version 2).

Current stores:

- `clientMeta` — stable `clientId`, `nextCounter`, `lamportClock`
- `documents`
- `operations` — canonical CRDT operation log (`opId` primary key; no `serverSeq` / ack / origin fields)
- `outbox` — `{ opId, documentId, createdAt }` markers for unacknowledged local operations
- `syncState` — `{ documentId, lastServerSeq }`

Snapshots, comments, and a service-worker offline shell are not implemented.

A v1 → v2 upgrade preserves existing rows, initializes `lastServerSeq = 0`, and re-queues locally originated operations into the outbox. Server duplicate handling makes that re-queue safe.

## Client Identity

A browser replica has a stable `clientId`.

Operation identity uses:

clientId + monotonically increasing client-local counter

The counter must never be reused after refresh or restart.

Counter allocation and operation persistence must ultimately be protected by a local transaction.

Counter gaps are acceptable.

Counter reuse is not.

## Lamport Clock

The local Lamport clock is persistent replica metadata.

Receiving a remote operation updates the logical clock.

Wall-clock timestamps remain informational metadata and do not determine convergence.

## Local Operations

A locally generated operation is durably persisted before the system considers it safely saved.

Network availability is not required to generate or retain the operation.

## Server Persistence

The server uses SQLite.

The central durable structure is an append-style operation log containing conceptually:

- global server sequence
- unique operation ID
- document ID
- client ID
- client-local counter
- operation type
- serialized operation payload
- client-created timestamp metadata
- server-received timestamp metadata

The database enforces durable uniqueness of operation identity.

## Document State

Whole-document content is not the authoritative collaboration record.

Visible text is materialized from CRDT state reconstructed from operations and, later, checkpoints.

## Snapshots

Snapshots are checkpoints / performance optimizations.

A snapshot records the server watermark through which it is valid.

A snapshot does not replace the operation log as the collaboration truth.

## Presence

Presence is ephemeral.

Online status, typing state, and future cursor presence are not durable document operations.

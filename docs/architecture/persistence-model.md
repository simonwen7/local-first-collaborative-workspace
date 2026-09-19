# Persistence Model

## Status

Implemented through Milestone 4 for the local-first operation log, outbox, per-document sync cursor, and client CRDT checkpoint cache.

## Client Persistence

The browser uses IndexedDB through Dexie (`lfcw-local-workspace`, version 3).

Current stores:

- `clientMeta` — stable `clientId`, `nextCounter`, `lamportClock`
- `documents`
- `operations` — canonical CRDT operation log (`opId` primary key; no `serverSeq` / ack / origin fields)
- `outbox` — `{ opId, documentId, createdAt }` markers for unacknowledged local operations
- `syncState` — `{ documentId, lastServerSeq }`
- `replicaSnapshots` — at most one derived `TextReplica` checkpoint per document

Canonical durable truth remains `operations` + `clientMeta` + `outbox` + `syncState`. `replicaSnapshots` is an acceleration cache. A missing, stale, or corrupt checkpoint must fall back to full operation replay. Checkpoints do not delete operation rows, tombstones, or historical payloads.

A v1 → v2 upgrade preserves existing rows, initializes `lastServerSeq = 0`, and re-queues locally originated operations into the outbox. Server duplicate handling makes that re-queue safe.

A v2 → v3 upgrade preserves every existing table and row and adds `replicaSnapshots`. It does not rewrite operations or create a checkpoint inside the Dexie upgrade transaction. The first Milestone 4 open of a migrated document reconstructs from the operation log, after which the controller may write the first checkpoint.

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

Client CRDT checkpoints are performance accelerators only.

A checkpoint stores a version-1 `TextReplica` snapshot plus the known-operation count it represents. It does not store `lastServerSeq`. `syncState` remains the source of truth for the server cursor. A checkpoint may include unacknowledged local operations and may be ahead of or behind `lastServerSeq`.

A snapshot does not replace the operation log as the collaboration truth. The complete canonical operation log is retained in IndexedDB and SQLite. Milestone 4 does not implement destructive operation compaction, tombstone garbage collection, or server-side snapshots.

After a trusted checkpoint restore, the controller still reapplies the complete canonical operation log. Operations already represented by the checkpoint become idempotent identity checks. Later suffix operations apply normally. If the checkpoint cannot be trusted, startup discards it in memory and rebuilds only from the canonical log.

## Presence

Presence is ephemeral.

Online status, typing state, and future cursor presence are not durable document operations.

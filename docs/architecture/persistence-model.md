# Persistence Model

## Status

Implemented through Milestone 8 for the local-first operation log, local workspace document catalog, outbox, per-document sync cursor, client CRDT checkpoint cache, optional authoritative server baseline, and single-node SQLite server history plus derived snapshot cache.

## Client Persistence

The browser uses IndexedDB through Dexie (`lfcw-local-workspace`, version 4).

Current stores:

- `clientMeta` — stable `clientId`, `nextCounter`, `lamportClock`
- `documents` — local workspace catalog (`id`, `title`, `createdAt`, `updatedAt`). Titles are local-only and are not synchronized.
- `operations` — canonical CRDT operation log (`opId` primary key; no `serverSeq` / ack / origin fields)
- `outbox` — `{ opId, documentId, createdAt }` markers for unacknowledged local operations
- `syncState` — `{ documentId, lastServerSeq }`
- `replicaSnapshots` — at most one derived `TextReplica` checkpoint per document
- `serverBaselines` — at most one authoritative server prefix snapshot per document (`&documentId`)

Canonical durable truth for a **full-log** document remains `operations` + `clientMeta` + `outbox` + `syncState`. `replicaSnapshots` is an acceleration cache.

Canonical durable truth for a **snapshot-bootstrapped** document is `serverBaselines` + suffix `operations` + `clientMeta` + `outbox` + `syncState`. Prefix operations with `server_seq <= snapshotSeq` are not materialized locally. `replicaSnapshots` is neither used nor written for those documents.

A v3 → v4 upgrade preserves every existing table and row and adds empty `serverBaselines`. It does not fabricate a baseline from an M4 checkpoint and does not rewrite operations.

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

Milestone 8 introduces `PRAGMA user_version` migrations. Version 1 is the existing operations schema. Version 2 adds `server_snapshots` (`document_id` primary key, `snapshot_seq`, `snapshot_version`, `snapshot_json`, `created_at`). The operations table is unchanged. Snapshot rows are a derived cache of `TextReplica.exportSnapshot()` at a fixed document barrier. If snapshot rows vanished, the complete operation log could regenerate them. M8 does not delete, truncate, or compact operations.

The database enforces durable uniqueness of operation identity. SQLite uses the library default rollback journal. WAL is not enabled.

The SQLite file is the canonical server history. There is no automated backup. For this rollback-journal deployment, take an application-consistent copy while the server is stopped, or use SQLite-aware backup tooling. Do not blindly copy a live database as a guaranteed safe backup. Clients cannot automatically rebuild a lost server.

`GET /ready` may run a non-mutating `SELECT 1` against the live connection. Readiness must not insert or delete operation rows.

## Document State

Whole-document content is not the authoritative collaboration record.

Visible text is materialized from CRDT state reconstructed from operations and, later, checkpoints.

## Snapshots

Client CRDT checkpoints are performance accelerators only.

A checkpoint stores a version-1 `TextReplica` snapshot plus the known-operation count it represents. It does not store `lastServerSeq`. `syncState` remains the source of truth for the server cursor. A checkpoint may include unacknowledged local operations and may be ahead of or behind `lastServerSeq`.

A snapshot does not replace the server operation log as the collaboration truth. The complete canonical operation log is retained in SQLite. Milestone 8 does not implement destructive operation compaction, tombstone garbage collection, or history deletion. Client M4 checkpoints still require a full local operation log; documents with an authoritative `serverBaselines` row skip M4 restore and automatic checkpoint creation.

After a trusted checkpoint restore, the controller still reapplies the complete canonical operation log. Operations already represented by the checkpoint become idempotent identity checks. Later suffix operations apply normally. If the checkpoint cannot be trusted, startup discards it in memory and rebuilds only from the canonical log.

## Local workspace

The `documents` table is the local workspace catalog. New documents use `crypto.randomUUID()`. The browser opens `/?document=<documentId>`. Missing routes canonicalize to `local-default-document`.

A browser replica keeps one global `clientId` and counter stream so local `opId` values stay unique across documents. Only one document session is connected at a time. An inactive document’s outbox remains durable and is flushed when that document is reopened.

Titles are local metadata. Rename updates `DocumentRecord.title` only. Collaborators may store different titles for the same shared id. The server still has no document registry, so an empty document and a never-created UUID remain indistinguishable.

## Presence

Presence is ephemeral.

Online status, typing state, and future cursor presence are not durable document operations.

# Persistence Model

## Status

Current local-first persistence: IndexedDB operation log, workspace catalog, outbox, per-document sync cursor, local CRDT checkpoint cache, optional authoritative server baseline, and single-node SQLite history plus a derived snapshot cache.

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

There are exactly two supported persisted shapes:

**Full-log document.** Canonical durable truth is `operations` + `clientMeta` + `outbox` + `syncState`. `replicaSnapshots` is an acceleration cache only.

**Snapshot-bootstrapped document.** Canonical durable truth is `serverBaselines` + suffix `operations` + `clientMeta` + `outbox` + `syncState`. Prefix operations with `server_seq <= snapshotSeq` are not materialized locally. `replicaSnapshots` is neither used nor written for those documents.

A v3 → v4 upgrade preserves every existing table and row and adds empty `serverBaselines`. It does not fabricate a baseline from a local checkpoint and does not rewrite operations.

A v1 → v2 upgrade preserves existing rows, initializes `lastServerSeq = 0`, and re-queues locally originated operations into the outbox. Server duplicate handling makes that re-queue safe.

A v2 → v3 upgrade preserves every existing table and row and adds `replicaSnapshots`. It does not rewrite operations or create a checkpoint inside the Dexie upgrade transaction. The first open after that upgrade reconstructs from the operation log, after which the controller may write the first checkpoint.

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

SQLite schema versioning uses `PRAGMA user_version`. Version 1 is the operations table/index. Version 2 adds `server_snapshots` (`document_id` primary key, `snapshot_seq`, `snapshot_version`, `snapshot_json`, `created_at`). Existing `user_version = 0` databases upgrade in place without rewriting or deleting operations. A binary that sees a newer `user_version` than it supports fails startup instead of downgrading.

**`operations` is canonical server history. `server_snapshots` is a derived cache** of `TextReplica.exportSnapshot()` at a fixed document barrier. If snapshot rows vanished, the complete operation log could regenerate them. The server does not delete, truncate, or compact operations.

The database enforces durable uniqueness of operation identity. SQLite uses the library default rollback journal. WAL is not enabled.

The SQLite file is the canonical server history. There is no automated backup. For this rollback-journal deployment, take an application-consistent copy while the server is stopped, or use SQLite-aware backup tooling. Do not blindly copy a live database as a guaranteed safe backup. Clients cannot automatically rebuild a lost server.

`GET /ready` may run a non-mutating `SELECT 1` against the live connection. Readiness must not insert or delete operation rows.

## Document State

Whole-document content is not the authoritative collaboration record.

Visible text is materialized from CRDT state reconstructed from the local operation log, or from an authoritative `serverBaselines` row plus suffix operations.

## Local checkpoints vs server baselines

**`replicaSnapshots` (local checkpoint cache).** Performance accelerator for full-log documents. Stores a version-1 `TextReplica` snapshot plus the known-operation count it represents. It does not store `lastServerSeq`. `syncState` remains the source of truth for the server cursor. A checkpoint may include unacknowledged local operations and may be ahead of or behind `lastServerSeq`. After a trusted restore, the controller still reapplies the complete local operation log. If the checkpoint cannot be trusted, startup discards it in memory and rebuilds only from the log.

**`serverBaselines` (authoritative local prefix).** Installed only from a validated server snapshot bootstrap. Prefix history is not fabricated into the operations table. Documents with a baseline skip local checkpoint restore and automatic checkpoint creation.

Server snapshots do not replace the SQLite operation log. The complete canonical operation log is retained. Destructive operation compaction, tombstone garbage collection, and history deletion are not implemented.

## Local workspace

The `documents` table is the local workspace catalog. New documents use `crypto.randomUUID()`. The browser opens `/?document=<documentId>`. Missing routes canonicalize to `local-default-document`.

A browser replica keeps one global `clientId` and counter stream so local `opId` values stay unique across documents. Only one document session is connected at a time. An inactive document’s outbox remains durable and is flushed when that document is reopened.

Titles are local metadata. Rename updates `DocumentRecord.title` only. Collaborators may store different titles for the same shared id. The server still has no document registry, so an empty document and a never-created UUID remain indistinguishable.

## Presence

Presence is not implemented. Sync Online / Offline is connection state, not a durable document operation.

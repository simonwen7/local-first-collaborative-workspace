# System Overview

## Product

Local-First Collaborative Document Workspace is a multi-client plain-text product built around independent browser replicas.

A client can keep editing while disconnected, persist those changes locally, reconnect later, exchange missing operations, and converge with other replicas without replacing the document through last-write-wins.

## Architecture

Four package boundaries:

1. `@lfcw/crdt` — `TextReplica`, a runtime-neutral collaborative text engine. No networking, persistence, UI, or server sequencing.
2. `@lfcw/protocol` — Zod-validated join, submit, sync, operation, and error messages, including optional snapshot bootstrap.
3. `apps/web` — React workspace, query-string document routing, `LocalDocumentController`, Dexie IndexedDB (v4, including `serverBaselines`), and `DocumentSyncClient`.
4. `apps/server` — Fastify process, WebSocket `/sync`, `OperationStore` (SQLite), derived server snapshots, `/health`, `/ready`, and process-local `/metrics`.

Production topology is **one Fastify process per SQLite database**. The server is not horizontally scalable. CI runs static checks, Vitest, then a Chromium Playwright job.

## Local-first path

User input → create a stable CRDT operation → persist the operation and outbox in IndexedDB → apply to `TextReplica` → update the UI → `DocumentSyncClient` submits when the socket is caught up.

The server stores, sequences, and relays operations. It is not the only copy of the document.

## Offline and reconnect

While disconnected, the client still opens local documents, creates operations, materializes text, and shows **Local: Saved**. Reconnect joins with the persisted cursor, downloads missing history through a fixed barrier (or a snapshot plus suffix for an eligible fresh client), then flushes the durable outbox.

## Shared package constraint

`packages/crdt` and `packages/protocol` must remain usable by both browser and Node runtimes. They must not depend on browser-only or Node-only globals.

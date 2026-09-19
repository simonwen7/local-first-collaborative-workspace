# Local-First Collaborative Document Workspace

A local-first collaborative document product designed to support realtime and offline editing across independent clients.

## Project Goal

The project is built around a difficult collaboration scenario:

1. Alice and Bob edit the same document.
2. Alice disconnects.
3. Alice continues editing locally.
4. Bob continues editing independently.
5. Alice reconnects.
6. Missing operations are exchanged.
7. Both replicas converge without replacing the entire document through last-write-wins.

The editor UI is the product surface. The synchronization engine is the primary engineering core.

## Current Status

Milestone 3 — Durable offline / reconnect synchronization.

The browser remains local-first. Documents load from IndexedDB. Local edits continue and are saved even when the collaboration server is unavailable.

Local operations are written atomically to the operation log and a durable outbox. Each document persists a `lastServerSeq` cursor meaning: every server operation for this document with `server_seq <= lastServerSeq` has been durably processed.

When the socket drops, the client automatically reconnects on a deterministic schedule (250ms, 500ms, 1s, 2s, then 4s). Reconnect joins with the persisted cursor, incrementally downloads missing SQLite history through a fixed barrier, then uploads remaining outbox operations. Sender echoes and reconnect replay both acknowledge outbox rows. Page reload does not lose unsent local operations.

The Fastify server still uses a global SQLite `server_seq` AUTOINCREMENT log. Gaps from other documents are not treated as missing operations for this document.

This is not a production-ready collaboration service.

Remaining limitations:

- no service-worker / PWA offline shell
- no snapshots or compaction
- no authentication, presence, or rich text
- a server history reset that leaves a client cursor ahead of SQLite requires intervention (`sync-cursor-ahead`)
- same-origin normal tabs still share one local replica and client identity

## Planned Architecture

- React + Vite browser application
- IndexedDB + Dexie local persistence (v2: operations, outbox, syncState)
- custom RGA-inspired collaborative text CRDT
- explicit WebSocket synchronization protocol (`@lfcw/protocol`)
- Fastify Node server with a `/sync` WebSocket endpoint
- SQLite durable operation log (`apps/server/data/lfcw.sqlite`)
- Vitest
- fast-check
- Playwright

The core demo is designed to run completely locally with no paid infrastructure or hosted collaboration service.

## Repository Structure

```text
apps/
  web/        Browser product
  server/     Local synchronization server

packages/
  crdt/       Pure collaborative text engine
  protocol/   Shared wire contracts

docs/
  architecture/
  decisions/
```

## Architecture Documentation

- `docs/architecture/system-overview.md`
- `docs/architecture/crdt-design.md`
- `docs/architecture/sync-protocol.md`
- `docs/architecture/persistence-model.md`
- `docs/architecture/testing-strategy.md`

Architecture Decision Records are located in `docs/decisions/`.

## Runtime

Use Node.js 24.

The repository intentionally rejects Node 25 through the root engine constraint.

## Development

Dependencies are managed using npm workspaces.

After installation:

```bash
npm run dev:web
npm run dev:server
```

`npm run dev:server` builds `@lfcw/crdt` and `@lfcw/protocol` first so the Node server does not depend on stale `dist` output. The server listens on `127.0.0.1:3001` by default. The web client connects to `ws://127.0.0.1:3001/sync` unless `VITE_SYNC_URL` is set.

Two isolated browser contexts (for example two Chrome profiles, or one normal window and one incognito window) can edit the same document and converge in realtime while the server is running. Same-origin tabs share one IndexedDB replica and therefore one client identity.

Verification commands:

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

Do not claim unsupported performance, scalability, or reliability numbers before they have been measured.

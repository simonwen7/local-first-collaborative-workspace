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

Milestone 2 — Online multi-client realtime synchronization.

The browser remains local-first. A document loads from IndexedDB and local edits continue to save even when the collaboration server is unavailable.

When the server is running, independent browser contexts can join the same logical document (`local-default-document`) over WebSocket. The Fastify server validates operations, appends them to a SQLite operation log, and broadcasts each accepted operation to every joined client, including the sender. The sender echo is the durable acceptance signal.

This is not a production-ready collaboration service.

Current M2 limitation: offline / reconnect replay is not implemented. After a previously online socket disconnects, later local edits stay local and are not automatically uploaded when the server returns.

## Planned Architecture

- React + Vite browser application
- IndexedDB + Dexie local persistence
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

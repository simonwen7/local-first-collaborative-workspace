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

Milestone 6 — Single-node production hardening, observability, repeatable deployment, and core CI.

This is a production-hardened **single-node** deployment. It is not a production-ready SaaS, is not horizontally scalable, and is not authenticated.

The browser remains local-first. The workspace lists locally known documents, creates new UUID documents, and opens a document from `/?document=<documentId>`. Titles and rename are local-only metadata. There is no document deletion.

Only one document session is active at a time. Switching closes the current sync socket and controller before opening the next. An inactive document’s durable outbox stays on disk and is flushed only when that document is opened again.

A valid unknown UUID opens as an empty local document and joins the server normally. The server still cannot distinguish a valid empty document from a never-created id. Sharing is unauthenticated: anyone with the document id or link can join that document.

Local operations are written atomically to the operation log and a durable outbox. Each document persists a `lastServerSeq` cursor meaning: every server operation for this document with `server_seq <= lastServerSeq` has been durably processed.

When the socket drops, the client automatically reconnects on a deterministic schedule (250ms, 500ms, 1s, 2s, then 4s). Reconnect joins with the persisted cursor, incrementally downloads missing SQLite history through a fixed barrier, then uploads remaining outbox operations. Sender echoes and reconnect replay both acknowledge outbox rows. Page reload does not lose unsent local operations.

Local cold-start can restore a complete `TextReplica` checkpoint from IndexedDB, then still reapply the full canonical operation log. Checkpoints accelerate reconstruction. They do not replace the operation log, delete historical rows, or garbage-collect tombstones. A missing, stale, or corrupt checkpoint falls back to full replay. Fresh clients still bootstrap from server operation history. The common sequential-insert replay path no longer walks every ancestor chain to `ROOT`.

The Fastify server still uses a global SQLite `server_seq` AUTOINCREMENT log. Gaps from other documents are not treated as missing operations for this document. The server does not store snapshots. SQLite journal mode is unchanged (library default rollback journal; WAL is not enabled).

The server now validates runtime configuration at startup, bounds inbound WebSocket frames and protocol string sizes, optionally allowlists browser Origins, heartbeats idle sockets, exposes `/ready` and process-local `/metrics`, logs structured WebSocket lifecycle events, and shuts down on SIGINT/SIGTERM. Docker Compose runs exactly one server replica with a named `/data` volume. GitHub Actions runs format/lint/typecheck/test/build on Node 24.13.0. Playwright is installed but browser E2E is not in CI.

This is not a production-ready collaboration service.

Remaining limitations:

- unauthenticated collaboration
- anyone who can reach the server and knows a document id can join
- single server process only; no horizontal scaling
- metrics are process-local and reset on restart
- no rate limiting
- no full outbound sync chunking/backpressure system
- fresh client receives full server history
- no server snapshot/compaction
- no automated backup
- no browser E2E in CI
- same-origin normal tabs still share one local replica and client identity
- no service-worker / PWA offline shell
- no destructive operation compaction or tombstone garbage collection
- no server-side document registry
- no collaborative titles, document deletion, authentication, or presence
- empty and never-created server documents are indistinguishable
- a server history reset that leaves a client cursor ahead of SQLite requires intervention (`sync-cursor-ahead`)

## Planned Architecture

- React + Vite browser application
- IndexedDB + Dexie local persistence (v3: operations, outbox, syncState, replicaSnapshots)
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
- `docs/architecture/deployment.md`

Architecture Decision Records are located in `docs/decisions/`.

## Runtime

Use Node.js 24.13.0 (see `.nvmrc`). The root `engines` field remains `>=24 <25`.

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

## Production / single-node deployment

Supported topology: **one stateful Fastify process** and **one persistent SQLite file**. Persistent SQLite is mandatory. The web app can be deployed as static files. The server requires long-lived WebSockets. Multi-instance deployment is not supported.

See `docs/architecture/deployment.md` for the operational runbook. Summary:

- `HOST` defaults to `127.0.0.1`. Docker/compose must set `HOST=0.0.0.0`.
- `PORT` defaults to `3001`. `SQLITE_PATH` defaults to `apps/server/data/lfcw.sqlite`.
- `LOG_LEVEL` defaults to `info`. `WS_MAX_PAYLOAD_BYTES` defaults to `262144` (inbound frames only; outbound `sync` history is not bounded).
- `WS_ALLOWED_ORIGINS` is empty by default (Origin filtering disabled). Set comma-separated exact origins such as `https://workspace.example.com` to allowlist browser Origins. This is not authentication.
- `WS_HEARTBEAT_INTERVAL_MS` defaults to `30000`. `SHUTDOWN_TIMEOUT_MS` defaults to `10000`.
- `GET /health` is liveness (`200 { "status": "ok" }`). `GET /ready` checks SQLite (`200` ready / `503` not_ready). `GET /metrics` is process-local Prometheus text and resets on restart.
- Operation contents, document text, and full sync payloads are not logged.
- HTTPS pages must use WSS. TLS terminates outside this Node process.
- If `VITE_SYNC_URL` is set at web build time, it must be `ws:` or `wss:`. If it is absent in a production build, the client uses `wss://<current-host>/sync` on HTTPS (same-origin; reverse-proxy `/sync` to Fastify). For split hosting:

  ```bash
  VITE_SYNC_URL=wss://sync.example.com/sync npm run build -w @lfcw/web
  ```

  Output: `apps/web/dist`.

```bash
docker build -t lfcw-server .
docker compose up --build
```

Compose publishes `3001:3001`, mounts named volume `lfcw-data` at `/data`, sets `SQLITE_PATH=/data/lfcw.sqlite`, and health-checks `/ready`.

The SQLite file is canonical server history. Loss of that file is serious. Back up with the server stopped or with SQLite-aware tooling; do not blindly copy a live database as a guaranteed safe backup. Clients cannot automatically rebuild a lost server. There is no automated backup subsystem.

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `typecheck`, `test`, and `build` on Node 24.13.0. It does not run Playwright E2E and does not publish images.

Do not claim unsupported performance, scalability, or reliability numbers before they have been measured.

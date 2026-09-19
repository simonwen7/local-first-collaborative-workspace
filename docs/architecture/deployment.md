# Deployment

## Status

This is a **production-hardened single-node deployment**. It is not a horizontally scalable SaaS architecture and is not access-controlled. Docker Compose runs the Fastify server only; the static web app is hosted separately.

## Supported architecture

Run **exactly one** Fastify process per SQLite database.

That process:

- serves `GET /health`, `GET /ready`, and `GET /metrics`
- accepts long-lived WebSockets at `/sync`
- appends the canonical operation history to SQLite
- may cache a derived per-document `TextReplica` snapshot for fresh-client bootstrap

The web application is a separately built static artifact (`apps/web/dist`). This Node process does not serve the Vite dev server and does not terminate TLS.

Multi-instance deployment is **not supported**. Do not run two replicas against the same SQLite file. There is no Redis, pub/sub, or shared room state.

## Persistent SQLite

`SQLITE_PATH` is mandatory in any real deployment. Loss of that file is loss of server history. Clients cannot automatically rebuild a lost server.

Default local-development path: `apps/server/data/lfcw.sqlite` (resolved from the compiled server).

Container path: `/data/lfcw.sqlite` on a named volume mounted at `/data`.

`PRAGMA user_version` migrations run before listen. Version 1 is the existing `operations` table/index. Version 2 adds `server_snapshots`. Existing databases with `user_version = 0` upgrade in place without rewriting or deleting operations. The snapshots table starts empty. A binary that sees a newer `user_version` than it supports fails startup instead of downgrading.

An older binary that does not know `server_snapshots` leaves that extra table unused. Because operations are not deleted, that rollback remains data-safe. Do not assume the same after any future destructive compaction.

SQLite uses the library default rollback journal. WAL is not enabled, and `synchronous` PRAGMAs are not changed. That is an intentional single-process choice. Server snapshots do not replace backups or canonical history.

## Backup

There is no automated backup subsystem.

The SQLite file is the canonical server history, including the derived `server_snapshots` cache when present. For this rollback-journal / single-process deployment:

- take an application-consistent copy **while the server is stopped**, or
- use SQLite-aware backup tooling

Do not treat a blind copy of a live database file as a guaranteed safe backup.

## Runtime configuration

Environment variables are read from `process.env` at startup. There is no dotenv loader. Invalid values fail startup with a clear error; `PORT` is never coerced to `NaN`.

| Variable                   | Default                        | Meaning                                                                                           |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `HOST`                     | `127.0.0.1`                    | Bind address. Local development stays on loopback. Containers must set `HOST=0.0.0.0` explicitly. |
| `PORT`                     | `3001`                         | TCP port (`1..65535`)                                                                             |
| `SQLITE_PATH`              | `apps/server/data/lfcw.sqlite` | SQLite file path                                                                                  |
| `LOG_LEVEL`                | `info`                         | Fastify/Pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`                  |
| `WS_MAX_PAYLOAD_BYTES`     | `262144`                       | Max **inbound** WebSocket frame payload                                                           |
| `WS_ALLOWED_ORIGINS`       | empty                          | Optional exact Origin allowlist                                                                   |
| `WS_HEARTBEAT_INTERVAL_MS` | `30000`                        | Server ping interval; unanswered sockets are terminated                                           |
| `SHUTDOWN_TIMEOUT_MS`      | `10000`                        | Graceful shutdown budget after SIGINT/SIGTERM                                                     |

### Origin allowlist

```bash
WS_ALLOWED_ORIGINS=https://workspace.example.com
```

Multiple origins are comma-separated exact values after trim. Empty / unset disables Origin filtering (all Origins, including missing Origin, are allowed).

If the allowlist is non-empty:

- a browser request whose `Origin` does not exactly match is rejected with HTTP 403 during upgrade
- a missing `Origin` remains allowed so non-browser clients and tests can connect

Origin policy is **not** authentication or authorization. Direct clients that omit `Origin` can still connect. Anyone who can reach the server and knows a document id can join that document.

### Inbound payload vs outbound sync

`WS_MAX_PAYLOAD_BYTES` bounds inbound client frames only.

Fresh-client `sync` responses can still be much larger because the server may send full document history or a snapshot whose CRDT payload is still O(history). There is no outbound chunking or backpressure subsystem. Server snapshots do not bound storage or message size.

## HTTP endpoints

| Path           | Role                          | Success                     | Failure                         |
| -------------- | ----------------------------- | --------------------------- | ------------------------------- |
| `GET /health`  | Liveness                      | `200 { "status": "ok" }`    | process is down                 |
| `GET /ready`   | SQLite readiness              | `200 { "status": "ready" }` | `503 { "status": "not_ready" }` |
| `GET /metrics` | Process-local Prometheus text | `text/plain; version=0.0.4` | process is down                 |

`/ready` uses a non-mutating SQLite `SELECT 1` against the live `OperationStore`. Internal SQLite errors are logged server-side and are not returned to the HTTP client.

`/metrics` aggregates only. Names do not include `documentId`, `clientId`, or operation contents. Counters and gauges reset when the process restarts. They are not a cluster-wide view.

Snapshot-related counters:

- `lfcw_snapshot_build_total`
- `lfcw_snapshot_build_failures_total`
- `lfcw_snapshot_bootstrap_total`
- `lfcw_snapshot_bytes_sent_total`
- `lfcw_snapshot_suffix_operations_sent_total`

These are process-local like the rest of `/metrics`. Snapshot JSON and document text are not logged or labeled.

## Web static deployment

Build the browser app as static files:

```bash
VITE_SYNC_URL=wss://sync.example.com/sync npm run build -w @lfcw/web
```

Output: `apps/web/dist`.

`VITE_SYNC_URL`, when set, must use `ws:` or `wss:`. An invalid value fails clearly instead of opening a bad WebSocket.

If `VITE_SYNC_URL` is absent:

- Vite **dev**: `ws://127.0.0.1:3001/sync`
- production browser build: same-origin `${ws|wss}://${window.location.host}/sync` (`http:` → `ws:`, `https:` → `wss:`)

Same-origin production mode assumes a reverse proxy routes `/sync` to Fastify. This repository does not ship a reverse-proxy configuration. TLS terminates outside this Node process.

Split static-web + sync-server hosting continues to use the `VITE_SYNC_URL` build-time override.

## HTTPS / WSS

An HTTPS web page must use WSS.

TLS termination is expected **outside** this Node process (load balancer, reverse proxy, or platform). Fastify does not load TLS certificates.

## Docker

Single replica only.

```bash
docker build -t lfcw-server .
docker compose up --build
```

Compose binds `3001:3001`, sets `HOST=0.0.0.0`, stores SQLite at `/data/lfcw.sqlite`, mounts named volume `lfcw-data` at `/data`, and health-checks `GET /ready`.

The container does not serve the web UI. Build and host `apps/web/dist` separately.

## Graceful shutdown

SIGINT and SIGTERM:

1. mark shutdown started (idempotent; a second signal does not start a second close)
2. Fastify `preClose` closes the WebSocket sync layer first: stop upgrades, stop heartbeat, and close active clients
3. Fastify then closes the HTTP server
4. SQLite is closed through Fastify `onClose`
5. the process exits `0` on success

If close exceeds `SHUTDOWN_TIMEOUT_MS`, the server logs `shutdown_timeout` and exits non-zero.

## Observability

Structured Pino logs (not operation values, document text, or full sync payloads) include:

- lifecycle: `server_starting`, `server_listening`, `shutdown_started`, `shutdown_complete`, `shutdown_timeout`, `startup_failed`
- WebSocket: `ws_connected`, `ws_joined`, `ws_sync_sent`, `ws_operation_inserted`, `ws_operation_duplicate`, `ws_identity_conflict`, `ws_protocol_error`, `ws_closed`

`connectionId` is a server-generated UUID for log correlation only. It is not persisted and is not part of the client protocol.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on push and pull_request with Node `24.13.0`:

`check`: `npm ci`, `format:check`, `lint`, `typecheck`, `test`, `build`.

`e2e` (after `check`): `npm ci`, `npx playwright install --with-deps chromium`, `npm run test:e2e`.

CI does not run `npm run format` (it must not mutate files) and does not publish Docker images. The Playwright job is Chromium-only and is not a Docker or Firefox/WebKit matrix.

## Current limitations

- unauthenticated collaboration
- anyone who can reach the server and knows a document id can join
- single server process only; no horizontal scaling
- metrics are process-local and reset on restart
- no rate limiting
- no full outbound sync chunking/backpressure system
- snapshot and full-history `sync` payloads can still be huge
- no automated backup
- Chromium-only Playwright gate; not Firefox/WebKit and not every manual disaster scenario
- same-origin tab identity limitation
- SQLite journal mode is unchanged (not WAL)
- no authentication, authorization, Redis, or multi-instance room state
- no compaction, history deletion, or tombstone GC

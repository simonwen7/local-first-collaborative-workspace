# Testing Strategy

## Principle

A visual demo is not sufficient. Static checks, automated tests, and a small real-browser gate must all pass.

## Validation Layers

### Static checks

- build
- TypeScript type checking
- ESLint
- formatting

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, `format:check`, `lint`, `typecheck`, `test`, and `build` on Node 24.13.0 for push and pull_request. After that core `check` job succeeds, a separate `e2e` job installs Chromium and runs `npm run test:e2e`. CI does not mutate files with `npm run format` and does not publish Docker images.

### Unit and property tests

`@lfcw/crdt` tests deterministic replica behavior independently of React, WebSocket, IndexedDB, and SQLite. `fast-check` generates legal operation sets and delivery permutations.

Primary properties:

- same valid operation set + different arrival order → same materialized state
- duplicate delivery does not change the result
- dependency disorder eventually resolves when dependencies arrive
- multiple replicas converge after receiving the same operation union

Property testing is not formal verification.

### Fake IndexedDB

Client Vitest suites use `fake-indexeddb` to prove Dexie durability, migrations, outbox/cursor atomicity, baseline install, and controller restore.

### Server integration and operational tests

Server tests cover SQLite append, duplicate and identity-conflict, schema migration, WebSocket join/sync/submit, snapshot policy, `/health` `/ready` `/metrics`, and graceful shutdown.

### Chromium E2E

Playwright uses independent browser contexts with separate client identity, IndexedDB, and connectivity state.

The gate is Chromium-only, serial (`workers: 1`, `retries: 0`), and runs against the **production Vite build** previewed on `127.0.0.1:4177` with `VITE_SYNC_URL=ws://127.0.0.1:3011/sync`. Each test owns a compiled Fastify process on `127.0.0.1:3011` and a unique temporary file-backed SQLite database.

First-time browsers: `npm run test:e2e:install`. Then `npm run test:e2e`. `npm test` stays Vitest-only.

Current suite (6 specs / 7 tests):

- workspace navigation, including invalid links
- two-context realtime collaboration
- offline reload plus reconnect outbox flush
- inactive-document outbox
- IME document-switch regression
- snapshot bootstrap (fresh contexts against a ≥1000-op document)

Small-history documents continue to use full-history sync. The suite does not run Firefox/WebKit and does not re-test protocol, Origin, metrics, heartbeat, or shutdown in the browser.

CI runs this gate after core checks. Failures upload `playwright-report/` and `test-results/` (traces and screenshots on failure only).

## Core invariant

A legal operation delivery order that causes replicas with the same operation set to materialize different documents is a CRDT correctness failure.

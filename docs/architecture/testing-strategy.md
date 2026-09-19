# Testing Strategy

## Principle

A milestone does not graduate because a visual demo appears to work.

Relevant static checks, automated tests, and manual acceptance scenarios must all pass.

## Validation Layers

### Static Checks

- build
- TypeScript type checking
- ESLint
- formatting

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, `format:check`, `lint`, `typecheck`, `test`, and `build` on Node 24.13.0 for push and pull_request. After that core `check` job succeeds, a separate `e2e` job installs Chromium and runs `npm run test:e2e`. CI does not mutate files with `npm run format` and does not publish Docker images.

### CRDT Unit Tests

The CRDT package will test deterministic behaviors independently of React, WebSocket, IndexedDB, and SQLite.

### Property-Based Tests

`fast-check` will generate legal operation sets and delivery permutations.

Primary properties include:

- same valid operation set + different arrival order → same materialized state
- duplicate delivery does not change the result
- dependency disorder eventually resolves when dependencies arrive
- multiple replicas converge after receiving the same operation union

Property testing is not described as formal verification.

### Persistence Tests

Client tests verify IndexedDB durability and reconstruction.

Server tests verify SQLite durability across server restart.

### Integration Tests

Client/server tests cover:

- push
- durable acknowledgement
- retry
- deduplication
- pull
- barriers
- reconnect

### Multi-Client E2E

Playwright uses genuinely independent browser contexts with separate client identity, IndexedDB, and connectivity state.

The permanent gate is Chromium-only, serial (`workers: 1`, `retries: 0`), and runs against the **production Vite build** previewed on `127.0.0.1:4177` with `VITE_SYNC_URL=ws://127.0.0.1:3011/sync`. Each test owns a compiled Fastify process on `127.0.0.1:3011` and a unique temporary file-backed SQLite database.

First-time browsers: `npm run test:e2e:install`. Then `npm run test:e2e`. `npm test` stays Vitest-only.

The suite covers workspace navigation (including invalid links), two-context realtime collaboration, offline reload plus reconnect outbox flush, inactive-document outbox, and the IME document-switch regression. It does not clone every M3/M5 manual scenario, does not run Firefox/WebKit, and does not re-test protocol/Origin/metrics/heartbeat/shutdown in the browser.

CI runs this gate after core checks. Failures upload `playwright-report/` and `test-results/` (traces and screenshots on failure only).

### Reliability Testing

Later milestones deliberately test:

- duplicate delivery
- out-of-order delivery
- lost acknowledgements
- connection loss during catch-up
- browser restart with pending edits
- server restart
- rapid edit bursts
- repeated reconnects
- identity corruption

## Core Graduation Invariant

A legal operation delivery order that causes replicas with the same operation set to materialize different documents is a CRDT correctness failure and blocks graduation.

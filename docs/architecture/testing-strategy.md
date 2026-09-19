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

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, `format:check`, `lint`, `typecheck`, `test`, and `build` on Node 24.13.0 for push and pull_request. CI does not mutate files with `npm run format`, does not publish Docker images, and does not run browser E2E.

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

Playwright will use genuinely independent browser contexts with separate client identity, IndexedDB, and connectivity state.

Milestone 6 CI does **not** run Playwright. Browser acceptance is not automated on every push. Playwright remains installed for a later milestone.

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

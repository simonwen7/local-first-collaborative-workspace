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

Milestone 1 — Single-client local-first core implementation.

The browser can now own a local CRDT replica and durable IndexedDB state. Server synchronization and multi-client collaboration remain later milestones.

## Planned Architecture

- React + Vite browser application
- IndexedDB + Dexie local persistence
- custom RGA-inspired collaborative text CRDT
- explicit WebSocket synchronization protocol
- Fastify Node server
- SQLite server persistence
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

Verification commands:

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

Do not claim unsupported performance, scalability, or reliability numbers before they have been measured.

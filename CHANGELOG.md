# Changelog

## 1.0.0 - 2026-09-19

First public-ready snapshot of the local-first collaborative workspace. This is a single-node engineering project, not a hosted collaboration service.

### Added

- Custom grapheme-aware plain-text CRDT (`TextReplica`) with deterministic convergence
- Local-first IndexedDB persistence and a multi-document workspace with shareable URLs
- Realtime WebSocket collaboration over an explicit protocol and SQLite sequenced log
- Durable offline outbox, reconnect catch-up, and sender-echo acknowledgement
- Local CRDT checkpoints for full-log documents
- Server snapshot bootstrap for eligible fresh clients (derived cache; full history retained)
- Single-node observability: `/health`, `/ready`, process-local `/metrics`, structured logs
- Docker Compose artifact for the **server only**, plus a Chromium Playwright reliability gate

### Reliability / operations

- Duplicate operation identity returns the existing `serverSeq`; conflicting payloads are rejected
- Graceful SIGINT/SIGTERM closes WebSocket sessions before SQLite
- GitHub Actions: format, lint, typecheck, Vitest, build, then Chromium E2E (`retries = 0`)

### Known limitations

- Unauthenticated collaboration: anyone who can reach the server and knows a document id can join
- One backend process and one SQLite database; no horizontal scaling
- No destructive compaction, tombstone garbage collection, or behind-client snapshot rebase
- Snapshot and full-history sync payloads remain O(history)
- Operator is responsible for SQLite backup

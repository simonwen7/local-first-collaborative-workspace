# Synchronization Protocol

## Status

Current protocol for realtime sync, reconnect catch-up, and optional snapshot bootstrap. Join `capabilities` and `sync.snapshotBootstrap` are optional fields. String fields have documented maximum lengths.

## Principle

Reconnect synchronization is operation based. Snapshot bootstrap is an optimization for explicitly capable, cursor-0, pristine clients.

The server never resolves collaboration by replacing the client document with a whole-document last-write-wins value. Server snapshots are a derived cache of a CRDT prefix. Complete SQLite operation history is retained.

## Current Messages

Client:

- `join` — `{ documentId, clientId, lastServerSeq, capabilities? }`
- `submit-operation` — `{ documentId, operation }`

Server:

- `sync` — missing document history after the client's `lastServerSeq`, through a fixed `latestServerSeq` barrier. Optional `snapshotBootstrap` is present only when the client advertised `snapshot-bootstrap-v1`, `lastServerSeq` is 0, and a valid snapshot cache is used. In that case `operations` is only the post-snapshot suffix.
- `operation` — one sequenced live operation; this is also the durable acceptance signal
- `error` — protocol, validation, identity-conflict, or `sync-cursor-ahead`

There is no separate ACK message. There is no protocol version field besides the optional capability string `snapshot-bootstrap-v1`. Clients that omit capabilities receive full/incremental operation history. A snapshot-capable client still accepts operations-only `sync`.

## Snapshot eligibility

The browser advertises `snapshot-bootstrap-v1` only when the opened document is locally pristine: `lastServerSeq == 0`, no `serverBaselines` row, no local operations, and no outbox.

The server sends a snapshot plus suffix only to those joins, and only when the document has at least 1000 operations. Any client with `lastServerSeq > 0` receives ordinary incremental history (`server_seq > cursor` through the barrier), even if `cursor` is behind a cached snapshot. Behind-client snapshot rebase is not implemented.

If snapshot build or install fails, the client falls back to full-history sync.

## Reconnect Flow

connect
→ join with persisted `lastServerSeq` (and optional capabilities)
→ receive one `sync` batch through a fixed barrier
→ persist and apply that batch, advancing the cursor atomically
→ flush the durable outbox
→ live `operation` messages continue afterwards
→ sender echo or reconnect replay clears matching outbox rows
→ Online when catch-up is complete and the outbox is empty

Catch-up is applied before outbox flush.

## Durable ACK Rule

The server must not echo or broadcast an operation before the SQLite write containing that operation has completed.

The client clears an outbox row only after the same `opId` arrives as sequenced server evidence and is processed in one IndexedDB transaction with cursor advancement.

## Idempotent Retry

Operations have stable identities.

If an acknowledgement is lost, the client resends the same operation from the outbox.

The server uses durable uniqueness of `(document_id, op_id)` to return the existing server sequence instead of inserting twice.

## Server Sequence

`serverSeq` is the global SQLite AUTOINCREMENT value.

It is synchronization metadata only. It must never determine CRDT text ordering.

Gaps caused by operations on other documents are valid. A document cursor means: every server operation relevant to this document with `server_seq <= lastServerSeq` has been durably processed.

## Catch-Up Barrier

A join captures `barrier = MAX(server_seq)` for that document, then returns operations where:

`server_seq > lastServerSeq AND server_seq <= barrier`

The barrier does not move during that sync send. Later accepted operations are live `operation` messages.

## Client Cursor

The client persists per-document `lastServerSeq`, starting at 0.

The cursor advances only inside the server-ingest IndexedDB transaction, to `max(current, confirmedThroughServerSeq)`, and never backwards.

If `lastServerSeq` is greater than the server's current document barrier, the server sends `sync-cursor-ahead` and does not join the socket. The protocol does not auto-repair a reset server history.

## Interrupted Pull

If the socket dies during ingest, the previous cursor remains unless that transaction committed.

A later reconnect may redeliver operations. Duplicate delivery is acceptable because persist and CRDT apply are idempotent.

## Online State

The UI shows Sync Online only when:

- catch-up for the current socket has completed
- the durable outbox is empty
- the socket is still open

## Protocol string limits

`@lfcw/protocol` rejects oversized strings:

- `documentId` max 64 (`local-default-document` and UUID ids remain valid)
- `clientId` max 128
- `opId` max 256
- element ids (`afterId` / `targetId`) max 256
- insert `value` max 16384

Integer semantics are unchanged. There are no extra charset restrictions beyond existing semantic validation.

## Transport boundaries

Inbound WebSocket frames are bounded by `WS_MAX_PAYLOAD_BYTES` (default 262144). This does **not** bound outbound `sync` history or snapshot bootstrap payloads.

Optional `WS_ALLOWED_ORIGINS` can reject browser upgrades whose `Origin` does not exactly match. Empty allowlist disables filtering. Missing `Origin` remains allowed for non-browser clients. Origin allowlisting is not authentication.

The server heartbeats with WebSocket ping/pong and terminates sockets that miss an interval. Clients already reconnect; the server does not.

`connectionId` exists only in server logs.

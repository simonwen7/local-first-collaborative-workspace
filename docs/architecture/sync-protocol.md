# Synchronization Protocol

## Status

Implemented through Milestone 3.

## Principle

Reconnect synchronization is operation based.

The server never resolves collaboration by replacing the client document with a whole-document last-write-wins value.

## Current Messages

Client:

- `join` — `{ documentId, clientId, lastServerSeq }`
- `submit-operation` — `{ documentId, operation }`

Server:

- `sync` — missing document history after the client's `lastServerSeq`, through a fixed `latestServerSeq` barrier
- `operation` — one sequenced live operation; this is also the durable acceptance signal
- `error` — protocol, validation, identity-conflict, or `sync-cursor-ahead`

There is no separate ACK message.

## Reconnect Flow

The implemented flow is:

connect
→ join with persisted `lastServerSeq`
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

If `lastServerSeq` is greater than the server's current document barrier, the server sends `sync-cursor-ahead` and does not join the socket. M3 does not auto-repair a reset server history.

## Interrupted Pull

If the socket dies during ingest, the previous cursor remains unless that transaction committed.

A later reconnect may redeliver operations. Duplicate delivery is acceptable because persist and CRDT apply are idempotent.

## Online State

The UI shows Sync Online only when:

- catch-up for the current socket has completed
- the durable outbox is empty
- the socket is still open

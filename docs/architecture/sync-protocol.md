# Synchronization Protocol

## Status

Accepted Milestone 0 protocol design. Message schemas are implemented later.

## Principle

Reconnect synchronization is operation based.

The server never resolves collaboration by replacing the client document with a whole-document last-write-wins value.

## Reconnect Flow

The intended flow is:

connect
→ hello
→ push local unacknowledged operations
→ durable server commit
→ acknowledgement
→ pull missing server operations to a fixed barrier
→ persist received operations locally
→ apply them to the local replica
→ complete the barrier
→ repeat if new local work appeared
→ synced

## Durable ACK Rule

The server must not acknowledge an operation before the SQLite transaction containing that operation has committed.

Broadcast also occurs after durable commit.

## Idempotent Retry

Operations have stable identities.

If an acknowledgement is lost, the client may resend the same operation.

The server uses durable uniqueness of operation identity to return the existing server sequence instead of applying the operation twice.

## Server Sequence

`serverSeq` is synchronization metadata only.

It must never determine CRDT text ordering or conflict resolution.

## Catch-Up Barrier

A pull round uses a fixed server watermark.

The target does not move while the client is catching up.

This prevents synchronization from chasing an endlessly moving head.

## Client Watermark

The client persists:

`confirmedThroughServerSeq`

Its meaning is:

The server has confirmed that, for this document, no required operation at or below this global server watermark is missing from the client.

It does not mean the document owns every global sequence number.

## Interrupted Pull

The watermark advances only after the complete barrier is durably processed.

If synchronization disconnects halfway through, the previous watermark remains.

A later retry may redeliver operations.

Duplicate delivery is acceptable because application is idempotent.

Silent data loss is not acceptable.

## Live Operations

Live operations may be persisted and applied immediately.

Initial correctness does not require live messages to advance the durable catch-up watermark.

A later catch-up may safely redeliver them.

## Synced State

The UI may display `Synced` only when:

- the WebSocket is connected
- there is no locally durable operation awaiting server acknowledgement
- no push request remains unresolved
- the latest catch-up barrier completed
- received operations are durably stored locally
- there is no unresolved CRDT dependency preventing the confirmed state from materializing

# ADR 0002: Local-First Persistence

## Status

Accepted.

## Context

Offline editing must remain fully functional when the server is unavailable.

Refresh or browser restart must not discard offline changes.

## Decision

Use IndexedDB through Dexie for durable client state and SQLite for durable server state.

Local operations are persisted independently of network availability.

## Consequences

The browser is a real replica rather than a thin server-backed UI.

Client identity, operation counters, logical clock state, pending operations, synchronization metadata, and document data require durable local modeling.

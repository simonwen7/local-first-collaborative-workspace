# ADR 0003: Explicit WebSocket Synchronization Protocol

## Status

Accepted.

## Context

The project must make reconnect behavior, retry behavior, missing-operation discovery, and durable acknowledgement understandable and testable.

## Decision

Use standard WebSocket transport with the `ws` server library and an explicit application-level synchronization protocol.

Do not use Socket.IO to hide reconnect and acknowledgement semantics.

## Consequences

The application owns:

- hello negotiation
- operation batches
- durable acknowledgements
- catch-up barriers
- retry semantics
- synchronization state transitions

This increases implementation work but makes the core reliability behavior explicit.

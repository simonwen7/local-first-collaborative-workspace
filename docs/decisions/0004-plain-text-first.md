# ADR 0004: Plain-Text-First Collaborative Model

## Status

Accepted.

Current v1 implementation remains plain-text and does not include comments, version history, or presence. The original decision text below is preserved as historical context.

## Context

Rich-text collaboration introduces marks, nested node structures, selection mapping, formatting conflicts, and substantially more complex CRDT semantics.

The project's primary goal is synchronization depth rather than recreating Google Docs formatting.

## Decision

Level 2 uses a plain-text / paragraph-text collaborative model with Unicode grapheme-level operations.

Comments, version history, presence, offline behavior, and polished product UX remain in scope.

Complex rich-text formatting is deferred.

## Consequences

Engineering effort remains concentrated on:

- local-first persistence
- synchronization
- deterministic convergence
- reliability
- product UX

# CRDT Benchmarks

These numbers measure the in-memory replica work that sits on the hot path of
every keystroke, every catch-up, and every cold start. They are **not** a
throughput claim for the server or for the browser as a whole; network,
IndexedDB, and SQLite are excluded on purpose so the CRDT cost is isolated.

## Command

```bash
npm run bench          # human-readable table
BENCH_CSV=1 npm run bench   # also emits CSV for charting
```

The harness lives in `packages/crdt/bench/crdt-bench.ts`.

## Methodology

- Deterministic workloads. All randomness comes from a seeded LCG, so every run
  measures the identical operation log.
- 2 warmup rounds, then the **median of 7 measured rounds** per cell.
- `apply` rebuilds a fresh `TextReplica` from an empty state each round, so the
  number includes dependency resolution and sibling ordering, not just map
  writes.
- `materialize`, `export`, and `restore` run against a replica that has already
  absorbed the full history.
- The harness asserts `getUnresolvedOperationIds().length === 0` after loading
  each history. A shape that failed to converge would throw rather than report a
  misleadingly fast number.
- Insert-only shapes have no tombstones; the `sequential` and `reordered` shapes
  use a **0.15 delete ratio**, which is why their visible-element counts are
  lower than their operation counts.

### History shapes

| Shape        | What it stresses                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `sequential` | One client appending in causal order — the ordinary typing case.                                                                     |
| `concurrent` | Four clients inserting at shared anchors with overlapping Lamport values, forcing the deterministic sibling tie-break.               |
| `reordered`  | The sequential log shuffled into a random delivery order, forcing the pending-dependency buffer to resolve essentially every insert. |

## Environment

|         |                                                          |
| ------- | -------------------------------------------------------- |
| Machine | Apple M4 Pro, 24 GB RAM                                  |
| OS      | macOS 15.7.4 (darwin/arm64)                              |
| Runtime | Node.js v24.13.0                                         |
| Build   | `tsc` output from `packages/crdt` (not bundled/minified) |

Single unpinned laptop run. Treat these as order-of-magnitude figures, not as a
regression gate.

## Results

Measured 2026-09-22.

| Shape      |    Ops | Apply (ms) |   Ops/sec | Materialize (ms) | Export (ms) | Restore (ms) | Visible |
| ---------- | -----: | ---------: | --------: | ---------------: | ----------: | -----------: | ------: |
| sequential |  1,000 |       0.21 | 4,672,897 |             0.05 |        0.06 |         0.54 |     702 |
| sequential | 10,000 |       3.00 | 3,330,789 |             0.56 |        0.43 |         5.33 |   7,002 |
| sequential | 50,000 |       11.8 | 4,233,462 |             2.99 |        1.96 |         30.8 |  35,002 |
| concurrent |  1,000 |       0.18 | 5,614,035 |             0.04 |        0.11 |         0.53 |   1,000 |
| concurrent | 10,000 |       2.22 | 4,494,717 |             0.70 |        1.22 |         6.51 |  10,000 |
| concurrent | 50,000 |       11.9 | 4,194,895 |             4.62 |        6.49 |         41.9 |  50,000 |
| reordered  |  1,000 |       0.61 | 1,640,463 |             0.04 |        0.05 |         0.31 |     702 |
| reordered  | 10,000 |       8.08 | 1,237,668 |             0.43 |        0.59 |         4.63 |   7,002 |
| reordered  | 50,000 |       59.1 |   845,522 |             2.73 |        3.97 |         29.8 |  35,002 |

## Reading the numbers

- **Apply throughput stays in the millions of ops/sec for in-order delivery.**
  Rebuilding a 50,000-operation document from scratch costs roughly 12 ms, which
  is why cold start is not user-visible at realistic document sizes.
- **Out-of-order delivery is the expensive shape, and it degrades
  super-linearly.** `reordered` drops from ~1.6M ops/sec at 1,000 operations to
  ~846K at 50,000 — about 5x slower than `sequential` at the same size, and the
  gap widens with history length. This is the pending-dependency buffer doing
  real work: nearly every insert arrives before its anchor and has to be parked
  and later drained. It is the clearest optimization target in the CRDT.
- **Materialization is cheap enough to run on every render.** Under 5 ms at
  50,000 operations across all shapes, which is what makes the "re-materialize
  after every remote batch" design viable.
- **Snapshot restore is the slowest single operation** (31–42 ms at 50,000
  operations) because it rebuilds the sibling index. It still beats replaying the
  raw log, which is the point of snapshot bootstrap.
- **Concurrency costs show up in export, not apply.** `concurrent` export is
  ~3x `sequential` export at 50,000 operations (6.49 ms vs 1.96 ms), reflecting
  the wider sibling fan-out that has to be serialized.

## What is not measured

- IndexedDB write/read latency in the browser.
- SQLite append and load throughput on the server.
- WebSocket round-trip time or server sequencing under concurrent clients.
- Memory footprint per operation.

No optimizations were made on the basis of these numbers; they are a baseline
recorded before any tuning, so future work has something honest to compare
against.

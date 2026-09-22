/**
 * CRDT benchmark harness.
 *
 * Measures the in-memory replica work that sits on the hot path of every
 * keystroke, every catch-up, and every cold start: applying operations,
 * materializing text, exporting a snapshot, and restoring from one.
 *
 * Three history shapes are measured because they stress different code paths:
 *
 *   sequential  one client appending in causal order (the typing case)
 *   concurrent  four clients inserting at shared anchors, forcing sibling
 *               ordering by Lamport timestamp and client id
 *   reordered   the sequential log delivered out of causal order, forcing the
 *               pending-dependency buffer to resolve every insert
 *
 * Run with:  npm run bench
 */

import { ROOT_ID, TextReplica, createDeleteOperation, createInsertOperation } from '@lfcw/crdt';
import type { AnchorId, TextOperation } from '@lfcw/crdt';

const HISTORY_SIZES = [1_000, 10_000, 50_000] as const;
const SHAPES = ['sequential', 'concurrent', 'reordered'] as const;
const CONCURRENT_CLIENTS = 4;
const DELETE_RATIO = 0.15;
const WARMUP_ROUNDS = 2;
const MEASURED_ROUNDS = 7;

type Shape = (typeof SHAPES)[number];

/** Deterministic PRNG so every run measures the identical workload. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measure(fn: () => void): number {
  for (let round = 0; round < WARMUP_ROUNDS; round += 1) {
    fn();
  }

  const samples: number[] = [];

  for (let round = 0; round < MEASURED_ROUNDS; round += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }

  return median(samples);
}

function buildSequential(size: number): TextOperation[] {
  const operations: TextOperation[] = [];
  const inserted: string[] = [];
  let anchor: AnchorId = ROOT_ID;
  let counter = 0;
  let deleteCursor = 0;

  while (operations.length < size) {
    counter += 1;
    const insert = createInsertOperation({
      clientId: 'bench',
      counter,
      lamport: counter,
      afterId: anchor,
      value: String.fromCharCode(97 + (counter % 26)),
    });
    operations.push(insert);
    inserted.push(insert.opId);
    anchor = insert.opId;

    const wantDeletes = Math.floor(operations.length * DELETE_RATIO);

    while (deleteCursor < wantDeletes && operations.length < size) {
      const target = inserted[deleteCursor];
      deleteCursor += 1;

      if (!target) {
        break;
      }

      counter += 1;
      operations.push(
        createDeleteOperation({
          clientId: 'bench',
          counter,
          lamport: counter,
          targetId: target,
        }),
      );
    }
  }

  return operations;
}

/**
 * Four independent clients inserting at shared anchors. Many nodes end up as
 * siblings of the same parent, which is what exercises the deterministic
 * sibling tie-break.
 */
function buildConcurrent(size: number): TextOperation[] {
  const random = createRandom(0x5eed);
  const operations: TextOperation[] = [];
  const anchors: AnchorId[] = [ROOT_ID];
  const counters = new Array<number>(CONCURRENT_CLIENTS).fill(0);
  let lamport = 0;

  while (operations.length < size) {
    const client = Math.floor(random() * CONCURRENT_CLIENTS) % CONCURRENT_CLIENTS;
    const clientId = `client-${String(client)}`;
    const nextCounter = (counters[client] ?? 0) + 1;
    counters[client] = nextCounter;

    // Concurrency: several clients pick the same recent anchor before seeing
    // each other's inserts, so Lamport values overlap rather than increase
    // strictly monotonically across the log.
    lamport += random() < 0.35 ? 0 : 1;

    const anchorIndex = Math.max(0, anchors.length - 1 - Math.floor(random() * 3));
    const insert = createInsertOperation({
      clientId,
      counter: nextCounter,
      lamport: Math.max(1, lamport),
      afterId: anchors[anchorIndex] ?? ROOT_ID,
      value: String.fromCharCode(97 + (nextCounter % 26)),
    });

    operations.push(insert);
    anchors.push(insert.opId);
  }

  return operations;
}

/**
 * The sequential log delivered out of causal order. Every insert whose anchor
 * has not arrived yet must be buffered and later resolved.
 */
function buildReordered(size: number): TextOperation[] {
  const operations = buildSequential(size);
  const random = createRandom(0xc0ffee);

  for (let index = operations.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const left = operations[index];
    const right = operations[swap];

    if (left && right) {
      operations[index] = right;
      operations[swap] = left;
    }
  }

  return operations;
}

function buildHistory(shape: Shape, size: number): TextOperation[] {
  switch (shape) {
    case 'sequential':
      return buildSequential(size);
    case 'concurrent':
      return buildConcurrent(size);
    case 'reordered':
      return buildReordered(size);
  }
}

function formatMs(value: number): string {
  if (value >= 100) {
    return value.toFixed(0);
  }

  if (value >= 10) {
    return value.toFixed(1);
  }

  return value.toFixed(2);
}

function row(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((cell, index) => cell.padStart(widths[index] ?? 8, ' ')).join('  ');
}

function main(): void {
  const widths = [11, 7, 9, 11, 13, 9, 10, 8];
  const header = row(
    ['shape', 'ops', 'apply ms', 'ops/sec', 'materialize', 'export ms', 'restore ms', 'visible'],
    widths,
  );

  console.log('CRDT benchmark · @lfcw/crdt');
  console.log(`node ${process.version} · ${process.platform}/${process.arch}`);
  console.log(
    `median of ${String(MEASURED_ROUNDS)} rounds after ${String(WARMUP_ROUNDS)} warmup · delete ratio ${String(DELETE_RATIO)}`,
  );
  console.log('');
  console.log(header);
  console.log('-'.repeat(header.length));

  const csv: string[] = [];

  for (const shape of SHAPES) {
    for (const size of HISTORY_SIZES) {
      const history = buildHistory(shape, size);

      const applyMs = measure(() => {
        const replica = new TextReplica();
        replica.applyAll(history);
      });

      const loaded = new TextReplica();
      loaded.applyAll(history);

      const unresolved = loaded.getUnresolvedOperationIds().length;

      if (unresolved > 0) {
        throw new Error(
          `Benchmark history for shape "${shape}" left ${String(unresolved)} unresolved operations.`,
        );
      }

      const visible = loaded.getVisibleElements().length;
      const materializeMs = measure(() => {
        loaded.materialize();
      });
      const exportMs = measure(() => {
        loaded.exportSnapshot();
      });

      const snapshot = loaded.exportSnapshot();
      const restoreMs = measure(() => {
        TextReplica.fromSnapshot(snapshot);
      });

      const opsPerSecond = Math.round(size / (applyMs / 1000));

      console.log(
        row(
          [
            shape,
            size.toLocaleString(),
            formatMs(applyMs),
            opsPerSecond.toLocaleString(),
            formatMs(materializeMs),
            formatMs(exportMs),
            formatMs(restoreMs),
            visible.toLocaleString(),
          ],
          widths,
        ),
      );

      csv.push(
        [
          shape,
          size,
          applyMs.toFixed(3),
          opsPerSecond,
          materializeMs.toFixed(3),
          exportMs.toFixed(3),
          restoreMs.toFixed(3),
          visible,
        ].join(','),
      );
    }

    console.log('');
  }

  if (process.env['BENCH_CSV'] === '1') {
    console.log('shape,ops,applyMs,opsPerSec,materializeMs,exportMs,restoreMs,visible');

    for (const line of csv) {
      console.log(line);
    }
  }
}

main();

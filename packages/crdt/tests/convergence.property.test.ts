import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ROOT_ID,
  TextReplica,
  createDeleteOperation,
  createInsertOperation,
} from '../src/index.js';
import type { TextOperation } from '../src/index.js';

function buildOperationSet(
  aliceValues: readonly string[],
  bobValues: readonly string[],
): TextOperation[] {
  const base = createInsertOperation({
    clientId: 'seed',
    counter: 1,
    lamport: 1,
    afterId: ROOT_ID,
    value: '|',
  });

  const operations: TextOperation[] = [base];

  let aliceAnchor = base.opId;

  aliceValues.forEach((value, index) => {
    const operation = createInsertOperation({
      clientId: 'alice',
      counter: index + 1,
      lamport: index + 2,
      afterId: aliceAnchor,
      value,
    });

    operations.push(operation);
    aliceAnchor = operation.opId;
  });

  let bobAnchor = base.opId;

  bobValues.forEach((value, index) => {
    const operation = createInsertOperation({
      clientId: 'bob',
      counter: index + 1,
      lamport: index + 2,
      afterId: bobAnchor,
      value,
    });

    operations.push(operation);
    bobAnchor = operation.opId;
  });

  if (aliceValues.length > 0) {
    operations.push(
      createDeleteOperation({
        clientId: 'deleter',
        counter: 1,
        lamport: 20,
        targetId: 'alice:1',
      }),
    );
  }

  return operations;
}

function orderByWeights(
  operations: readonly TextOperation[],
  weights: readonly number[],
): TextOperation[] {
  return operations
    .map((operation, index) => ({
      operation,
      weight: weights[index] ?? 0,
      index,
    }))
    .sort((left, right) => {
      if (left.weight !== right.weight) {
        return left.weight - right.weight;
      }

      return left.index - right.index;
    })
    .map(({ operation }) => operation);
}

describe('TextReplica convergence properties', () => {
  it('converges for the same valid operation set under different arrival orders', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', '中', '😀'), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.array(fc.constantFrom('x', 'y', '文', '🚀'), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.array(fc.integer(), {
          minLength: 12,
          maxLength: 12,
        }),
        fc.array(fc.integer(), {
          minLength: 12,
          maxLength: 12,
        }),
        (aliceValues, bobValues, firstWeights, secondWeights) => {
          const operations = buildOperationSet(aliceValues, bobValues);

          const first = new TextReplica();
          first.applyAll(orderByWeights(operations, firstWeights));

          const second = new TextReplica();
          second.applyAll(orderByWeights(operations, secondWeights));

          expect(first.getUnresolvedOperationIds()).toEqual([]);
          expect(second.getUnresolvedOperationIds()).toEqual([]);
          expect(first.materialize()).toBe(second.materialize());
        },
      ),
      {
        numRuns: 200,
      },
    );
  });

  it('is unchanged by duplicate delivery', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', '中', '😀'), {
          minLength: 1,
          maxLength: 4,
        }),
        (values) => {
          const operations = buildOperationSet(values, ['x']);

          const baseline = new TextReplica();
          baseline.applyAll(operations);

          const duplicated = new TextReplica();

          for (const operation of operations) {
            duplicated.apply(operation);
            duplicated.apply(operation);
          }

          expect(duplicated.materialize()).toBe(baseline.materialize());
        },
      ),
      {
        numRuns: 100,
      },
    );
  });
});

import { describe, expect, it } from 'vitest';
import { CompositionGate } from '../src/editor/composition-gate';

describe('CompositionGate', () => {
  it('does not hold remote ingestion when no composition is active', async () => {
    const gate = new CompositionGate();

    expect(gate.isHolding()).toBe(false);
    await gate.waitUntilLocalCommitComplete();
    expect(gate.isHolding()).toBe(false);
  });

  it('keeps remote ingestion closed until the local composition commit is released', async () => {
    const gate = new CompositionGate();
    const ingested: string[] = [];

    gate.begin();
    expect(gate.isHolding()).toBe(true);

    let localCommitFinished = false;

    const remoteIngest = gate.waitUntilLocalCommitComplete().then(() => {
      ingested.push('remote');
    });

    const localCommit = Promise.resolve().then(() => {
      localCommitFinished = true;
      ingested.push('local');
      gate.release();
    });

    await Promise.all([localCommit, remoteIngest]);

    expect(localCommitFinished).toBe(true);
    expect(ingested).toEqual(['local', 'remote']);
    expect(gate.isHolding()).toBe(false);
  });

  it('releases waiters in finally even when the local commit rejects', async () => {
    const gate = new CompositionGate();

    gate.begin();

    const remoteIngest = gate.waitUntilLocalCommitComplete();

    await Promise.resolve()
      .then(() => {
        throw new Error('local commit failed');
      })
      .catch(() => undefined)
      .finally(() => {
        gate.release();
      });

    await remoteIngest;
    expect(gate.isHolding()).toBe(false);
  });

  it('does not open the gate at compositionend before commit completion', async () => {
    const gate = new CompositionGate();
    let remoteSawHold = false;

    gate.begin();

    const remoteIngest = (async () => {
      remoteSawHold = gate.isHolding();
      await gate.waitUntilLocalCommitComplete();
    })();

    await Promise.resolve();
    expect(gate.isHolding()).toBe(true);
    expect(remoteSawHold).toBe(true);

    gate.release();
    await remoteIngest;
  });
});

import { describe, expect, it } from 'vitest';
import { CompositionGate } from '../src/editor/composition-gate';
import { SessionTransitionQueue } from '../src/workspace/session-transition';

describe('SessionTransitionQueue', () => {
  it('does not overlap transitions and keeps the latest pending target', async () => {
    const queue = new SessionTransitionQueue();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const switchTo = async (documentId: string, generation: number) => {
      order.push(`${documentId}:${generation}`);

      if (documentId === 'A') {
        await firstGate;
      }
    };

    queue.request('A', switchTo);
    await Promise.resolve();
    queue.request('B', switchTo);
    queue.request('C', switchTo);

    expect(queue.isInFlight()).toBe(true);
    releaseFirst?.();
    await queue.whenIdle();

    expect(order).toEqual(['A:1', 'C:2']);
    expect(queue.isCurrent(2)).toBe(true);
    expect(queue.isCurrent(1)).toBe(false);
    expect(queue.isInFlight()).toBe(false);
  });

  it('closes the conceptual old session before creating the next', async () => {
    const queue = new SessionTransitionQueue();
    const events: string[] = [];

    queue.request('A', async () => {
      events.push('open-A');
    });
    await Promise.resolve();
    queue.request('B', async () => {
      events.push('close-previous');
      events.push('open-B');
    });

    await queue.whenIdle();
    expect(events).toEqual(['open-A', 'close-previous', 'open-B']);
  });

  it('keeps the current generation valid until a held composition commit finishes', async () => {
    const queue = new SessionTransitionQueue();
    const gate = new CompositionGate();
    const events: string[] = [];
    const source = {
      closed: false,
      generation: 0,
    };

    const prepare = async () => {
      events.push(`prepare-generation:${queue.getGeneration()}`);

      if (gate.isHolding()) {
        await gate.waitUntilLocalCommitComplete();
      }

      events.push(`commit-complete-generation:${queue.getGeneration()}`);
      expect(source.closed).toBe(false);
      expect(queue.isCurrent(source.generation)).toBe(true);
    };

    const switchTo = async (documentId: string, generation: number) => {
      events.push('close-source');
      source.closed = true;
      source.generation = generation;
      events.push(`open-${documentId}:${generation}`);
    };

    gate.begin();
    queue.request('B', switchTo, prepare);
    await Promise.resolve();
    await Promise.resolve();

    expect(source.closed).toBe(false);
    expect(queue.getGeneration()).toBe(0);
    expect(queue.isCurrent(0)).toBe(true);
    expect(events).toEqual(['prepare-generation:0']);

    events.push('source-commit');
    gate.release();
    await queue.whenIdle();

    expect(events).toEqual([
      'prepare-generation:0',
      'source-commit',
      'commit-complete-generation:0',
      'close-source',
      'open-B:1',
    ]);
    expect(source.closed).toBe(true);
    expect(queue.isCurrent(1)).toBe(true);
  });

  it('waits for the source composition, then opens only the latest pending target', async () => {
    const queue = new SessionTransitionQueue();
    const gate = new CompositionGate();
    const events: string[] = [];
    let sourceClosed = false;

    const prepare = async () => {
      if (gate.isHolding()) {
        await gate.waitUntilLocalCommitComplete();
      }

      expect(sourceClosed).toBe(false);
      expect(queue.getGeneration()).toBe(0);
    };

    const switchTo = async (documentId: string, generation: number) => {
      sourceClosed = true;
      events.push(`open-${documentId}:${generation}`);
    };

    gate.begin();
    queue.request('B', switchTo, prepare);
    await Promise.resolve();
    queue.request('C', switchTo, prepare);

    expect(sourceClosed).toBe(false);
    expect(events).toEqual([]);
    expect(queue.getGeneration()).toBe(0);

    gate.release();
    await queue.whenIdle();

    expect(events).toEqual(['open-C:1']);
    expect(queue.isCurrent(1)).toBe(true);
    expect(queue.isCurrent(0)).toBe(false);
  });
});

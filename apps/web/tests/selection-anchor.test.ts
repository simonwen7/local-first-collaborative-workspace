import { describe, expect, it } from 'vitest';
import { ROOT_ID, TextReplica, createDeleteOperation, createInsertOperation } from '@lfcw/crdt';
import type { AnchorId, VisibleElement } from '@lfcw/crdt';
import {
  captureSelectionAnchor,
  elementIndexToOffset,
  offsetToElementIndex,
  resolveSelectionAnchor,
} from '../src/editor/selection-anchor';

function elements(...values: readonly string[]): VisibleElement[] {
  return values.map((value, index) => ({
    id: `client-a:${String(index + 1)}`,
    value,
  }));
}

/** Build a replica whose visible text is `text`, one grapheme per element. */
function replicaOf(text: string, clientId = 'remote'): TextReplica {
  const replica = new TextReplica();
  let anchor: AnchorId = ROOT_ID;
  let counter = 0;

  for (const value of [...text]) {
    counter += 1;
    const insert = createInsertOperation({
      clientId,
      counter,
      lamport: counter,
      afterId: anchor,
      value,
    });
    replica.apply(insert);
    anchor = insert.opId;
  }

  return replica;
}

describe('offset/element index conversion', () => {
  it('maps UTF-16 offsets onto grapheme element boundaries', () => {
    const list = elements('a', '👋', 'b');

    expect(offsetToElementIndex(list, 0)).toBe(0);
    expect(offsetToElementIndex(list, 1)).toBe(1);
    // The emoji occupies two UTF-16 code units, so offset 2 lands mid-element
    // and must resolve to the element that contains it.
    expect(offsetToElementIndex(list, 2)).toBe(2);
    expect(offsetToElementIndex(list, 3)).toBe(2);
    expect(offsetToElementIndex(list, 4)).toBe(3);
    expect(offsetToElementIndex(list, 99)).toBe(3);
  });

  it('round-trips element indices back to offsets', () => {
    const list = elements('a', '👋', 'b');

    expect(elementIndexToOffset(list, 0)).toBe(0);
    expect(elementIndexToOffset(list, 1)).toBe(1);
    expect(elementIndexToOffset(list, 2)).toBe(3);
    expect(elementIndexToOffset(list, 3)).toBe(4);
  });
});

describe('selection anchoring', () => {
  it('keeps the caret in place when a remote insert lands before it', () => {
    const before = elements('h', 'e', 'l', 'l', 'o');
    const anchor = captureSelectionAnchor(before, 5, 5);

    // A remote client inserted two elements at the very front.
    const after: VisibleElement[] = [
      { id: 'remote:1', value: 'X' },
      { id: 'remote:2', value: 'Y' },
      ...before,
    ];

    expect(resolveSelectionAnchor(after, anchor)).toEqual({ start: 7, end: 7 });
  });

  it('keeps the caret in place when a remote insert lands after it', () => {
    const before = elements('h', 'i');
    const anchor = captureSelectionAnchor(before, 1, 1);
    const after: VisibleElement[] = [...before, { id: 'remote:1', value: '!' }];

    expect(resolveSelectionAnchor(after, anchor)).toEqual({ start: 1, end: 1 });
  });

  it('preserves a selection range across a remote prefix insert', () => {
    const before = elements('a', 'b', 'c', 'd');
    const anchor = captureSelectionAnchor(before, 1, 3);
    const after: VisibleElement[] = [{ id: 'remote:1', value: 'Z' }, ...before];

    expect(resolveSelectionAnchor(after, anchor)).toEqual({ start: 2, end: 4 });
  });

  it('falls back to the nearest surviving predecessor when the anchor is deleted', () => {
    const before = elements('a', 'b', 'c');
    const anchor = captureSelectionAnchor(before, 3, 3);

    // "c" was tombstoned remotely; the caret should land after "b", not jump.
    const after = before.slice(0, 2);

    expect(resolveSelectionAnchor(after, anchor)).toEqual({ start: 2, end: 2 });
  });

  it('collapses to the document start when every predecessor is deleted', () => {
    const before = elements('a', 'b');
    const anchor = captureSelectionAnchor(before, 2, 2);

    expect(resolveSelectionAnchor([], anchor)).toEqual({ start: 0, end: 0 });
  });

  it('anchors position zero to ROOT so a leading insert does not drag the caret', () => {
    const before = elements('a', 'b');
    const anchor = captureSelectionAnchor(before, 0, 0);

    expect(anchor.startAfterId).toBe(ROOT_ID);
    expect(resolveSelectionAnchor([{ id: 'remote:1', value: 'Z' }, ...before], anchor)).toEqual({
      start: 0,
      end: 0,
    });
  });

  it('holds the caret across a real remote insert applied to a live replica', () => {
    const replica = replicaOf('hello');
    const before = replica.getVisibleElements();
    const caret = replica.materialize().length;
    const anchor = captureSelectionAnchor(before, caret, caret);

    // A second replica inserts at the front through the normal apply path.
    replica.apply(
      createInsertOperation({
        clientId: 'other',
        counter: 1,
        lamport: 99,
        afterId: ROOT_ID,
        value: '>',
      }),
    );

    const after = replica.getVisibleElements();
    const resolved = resolveSelectionAnchor(after, anchor);

    expect(replica.materialize()).toBe('>hello');
    expect(resolved).toEqual({ start: 6, end: 6 });
    // Naive offset restoration would have left the caret before the final "o".
    expect(resolved?.start).not.toBe(caret);
  });

  it('holds the caret when a remote delete removes text before it', () => {
    const replica = replicaOf('abcdef');
    const before = replica.getVisibleElements();
    const anchor = captureSelectionAnchor(before, 6, 6);
    const victim = before[0];

    if (!victim) {
      throw new Error('Expected a first element.');
    }

    replica.apply(
      createDeleteOperation({
        clientId: 'other',
        counter: 1,
        lamport: 99,
        targetId: victim.id,
      }),
    );

    const after = replica.getVisibleElements();

    expect(replica.materialize()).toBe('bcdef');
    expect(resolveSelectionAnchor(after, anchor)).toEqual({ start: 5, end: 5 });
  });
});

import { ROOT_ID } from '@lfcw/crdt';
import type { AnchorId, VisibleElement } from '@lfcw/crdt';

/**
 * A caret position expressed in CRDT identity space rather than character
 * offsets.
 *
 * `afterId` is the identity of the element immediately before the caret, or
 * ROOT when the caret sits at the start of the document. Anchoring to identity
 * means a remote insert or delete elsewhere in the document cannot silently
 * shift the local caret, which raw offset restoration would do.
 *
 * `fallbackTrail` records the identities that preceded the caret at capture
 * time, nearest first. If the anchor element is deleted concurrently we walk
 * that trail to the closest surviving predecessor instead of collapsing to the
 * start of the document.
 */
export interface SelectionAnchor {
  readonly startAfterId: AnchorId;
  readonly endAfterId: AnchorId;
  readonly startFallbackTrail: readonly AnchorId[];
  readonly endFallbackTrail: readonly AnchorId[];
  readonly direction: 'forward' | 'backward' | 'none';
}

export interface SelectionOffsets {
  readonly start: number;
  readonly end: number;
}

const MAX_FALLBACK_TRAIL = 32;

/**
 * Convert a UTF-16 offset into an element index. Elements hold grapheme
 * clusters, which may be several code units wide, so offsets and indices are
 * not interchangeable.
 */
export function offsetToElementIndex(elements: readonly VisibleElement[], offset: number): number {
  if (offset <= 0) {
    return 0;
  }

  let consumed = 0;

  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];

    if (!element) {
      continue;
    }

    consumed += element.value.length;

    if (consumed >= offset) {
      return index + 1;
    }
  }

  return elements.length;
}

export function elementIndexToOffset(
  elements: readonly VisibleElement[],
  elementIndex: number,
): number {
  const bounded = Math.max(0, Math.min(elementIndex, elements.length));
  let offset = 0;

  for (let index = 0; index < bounded; index += 1) {
    offset += elements[index]?.value.length ?? 0;
  }

  return offset;
}

function trailFrom(elements: readonly VisibleElement[], elementIndex: number): AnchorId[] {
  const trail: AnchorId[] = [];

  for (let index = elementIndex - 1; index >= 0 && trail.length < MAX_FALLBACK_TRAIL; index -= 1) {
    const id = elements[index]?.id;

    if (id) {
      trail.push(id);
    }
  }

  trail.push(ROOT_ID);
  return trail;
}

export function captureSelectionAnchor(
  elements: readonly VisibleElement[],
  selectionStart: number,
  selectionEnd: number,
  direction: 'forward' | 'backward' | 'none' = 'forward',
): SelectionAnchor {
  const startIndex = offsetToElementIndex(elements, selectionStart);
  const endIndex = offsetToElementIndex(elements, selectionEnd);
  const startTrail = trailFrom(elements, startIndex);
  const endTrail = trailFrom(elements, endIndex);

  return {
    startAfterId: startTrail[0] ?? ROOT_ID,
    endAfterId: endTrail[0] ?? ROOT_ID,
    startFallbackTrail: startTrail,
    endFallbackTrail: endTrail,
    direction,
  };
}

function resolveTrailOffset(
  elements: readonly VisibleElement[],
  trail: readonly AnchorId[],
): number | null {
  const indexById = new Map<AnchorId, number>();

  for (let index = 0; index < elements.length; index += 1) {
    const id = elements[index]?.id;

    if (id !== undefined) {
      indexById.set(id, index);
    }
  }

  for (const candidate of trail) {
    if (candidate === ROOT_ID) {
      return 0;
    }

    const index = indexById.get(candidate);

    if (index !== undefined) {
      return elementIndexToOffset(elements, index + 1);
    }
  }

  return null;
}

/**
 * Resolve a previously captured anchor against the post-apply element list.
 *
 * Returns null when the anchor cannot be resolved at all, which lets the caller
 * decide to leave the caret untouched rather than guess.
 */
export function resolveSelectionAnchor(
  elements: readonly VisibleElement[],
  anchor: SelectionAnchor,
): SelectionOffsets | null {
  const start = resolveTrailOffset(elements, anchor.startFallbackTrail);
  const end = resolveTrailOffset(elements, anchor.endFallbackTrail);

  if (start === null || end === null) {
    return null;
  }

  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
}

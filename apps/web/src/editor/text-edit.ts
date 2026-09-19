import { ROOT_ID } from '@lfcw/crdt';
import type { AnchorId, ElementId, VisibleElement } from '@lfcw/crdt';
import { segmentGraphemes } from './graphemes';

export interface LocalTextEdit {
  readonly deleteTargetIds: readonly ElementId[];
  readonly insertAfterId: AnchorId;
  readonly insertValues: readonly string[];
}

export function computeLocalTextEdit(
  currentElements: readonly VisibleElement[],
  nextText: string,
): LocalTextEdit | null {
  const currentValues = currentElements.map((element) => element.value);
  const nextValues = segmentGraphemes(nextText);

  let prefixLength = 0;

  while (
    prefixLength < currentValues.length &&
    prefixLength < nextValues.length &&
    currentValues[prefixLength] === nextValues[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;

  while (
    suffixLength < currentValues.length - prefixLength &&
    suffixLength < nextValues.length - prefixLength &&
    currentValues[currentValues.length - 1 - suffixLength] ===
      nextValues[nextValues.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const currentChangeEnd = currentValues.length - suffixLength;
  const nextChangeEnd = nextValues.length - suffixLength;

  const deleteTargetIds = currentElements
    .slice(prefixLength, currentChangeEnd)
    .map((element) => element.id);

  const insertValues = nextValues.slice(prefixLength, nextChangeEnd);

  if (deleteTargetIds.length === 0 && insertValues.length === 0) {
    return null;
  }

  const previousElement = prefixLength > 0 ? currentElements[prefixLength - 1] : undefined;

  return {
    deleteTargetIds,
    insertAfterId: previousElement?.id ?? ROOT_ID,
    insertValues,
  };
}

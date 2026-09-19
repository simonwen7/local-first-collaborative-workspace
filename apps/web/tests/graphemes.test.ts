import { describe, expect, it } from 'vitest';
import { segmentGraphemes } from '../src/editor/graphemes';

describe('segmentGraphemes', () => {
  it('segments ASCII, Chinese, accented text, and joined emoji', () => {
    expect(segmentGraphemes('Hello')).toEqual(['H', 'e', 'l', 'l', 'o']);

    expect(segmentGraphemes('协作')).toEqual(['协', '作']);

    expect(segmentGraphemes('é')).toEqual(['é']);

    expect(segmentGraphemes('👨‍👩‍👧‍👦')).toEqual(['👨‍👩‍👧‍👦']);
  });
});

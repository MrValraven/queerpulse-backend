import {
  STUDIO_SEARCH_FIRST_WINDOW,
  STUDIO_SEARCH_MAX_OFFSET,
  decodeStudioSearchCursor,
  encodeStudioSearchCursor,
  nextStudioSearchCursor,
  sliceStudioSearchRows,
  studioSearchRowLimit,
  studioSearchWindowAt,
} from './studio-search-cursor';

describe('studio search cursor (ENG-05)', () => {
  it('round-trips an offset through the opaque cursor', () => {
    expect(decodeStudioSearchCursor(encodeStudioSearchCursor(40))).toBe(40);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not base64 of a search cursor', 'abc'],
    ['a release cursor', Buffer.from('2026-10-01|x').toString('base64url')],
    ['a negative offset', Buffer.from('search|-20').toString('base64url')],
    ['a fractional offset', Buffer.from('search|2.5').toString('base64url')],
  ])('reads a %s cursor as the first page', (_label, cursor) => {
    expect(decodeStudioSearchCursor(cursor)).toBe(0);
  });

  it('reads a cursor past the depth cap as the first page', () => {
    expect(
      decodeStudioSearchCursor(
        encodeStudioSearchCursor(STUDIO_SEARCH_MAX_OFFSET + 20),
      ),
    ).toBe(0);
  });

  it('reads one probe row only on a paged window', () => {
    expect(studioSearchRowLimit(STUDIO_SEARCH_FIRST_WINDOW)).toBe(20);
    expect(studioSearchRowLimit(studioSearchWindowAt(0))).toBe(21);
  });

  it('splits the probe row off and says more exist', () => {
    const rows = Array.from({ length: 21 }, (_unused, index) => index);
    const { pageRows, hasMore } = sliceStudioSearchRows(
      rows,
      studioSearchWindowAt(0),
    );
    expect(pageRows).toHaveLength(20);
    expect(hasMore).toBe(true);
  });

  it('never claims more on the unpaged multi-type window', () => {
    const rows = Array.from({ length: 20 }, (_unused, index) => index);
    expect(
      sliceStudioSearchRows(rows, STUDIO_SEARCH_FIRST_WINDOW).hasMore,
    ).toBe(false);
  });

  it('points the next cursor one page on, and answers null on the last page', () => {
    const window = studioSearchWindowAt(20);
    expect(
      decodeStudioSearchCursor(nextStudioSearchCursor(window, true)!),
    ).toBe(40);
    expect(nextStudioSearchCursor(window, false)).toBeNull();
  });

  it('stops emitting cursors at the depth cap', () => {
    expect(
      nextStudioSearchCursor(
        studioSearchWindowAt(STUDIO_SEARCH_MAX_OFFSET),
        true,
      ),
    ).toBeNull();
  });
});

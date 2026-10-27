import {
  STUDIO_LISTENING_RANGES,
  STUDIO_LISTENING_RANGE_INTERVALS,
  STUDIO_LISTENING_RETENTION_INTERVAL,
  STUDIO_LISTENING_TOP_SHOWN,
  STUDIO_LISTENS_PER_PAGE,
  decodeListenCursor,
  encodeListenCursor,
} from './studio-listening-history';

const LISTEN_ID = '3f2b8a52-6f0e-4c1a-9d57-0a1b2c3d4e5f';

describe('studio listening history shapes', () => {
  it('maps each range to its window', () => {
    expect(
      STUDIO_LISTENING_RANGES.map(
        (range) => STUDIO_LISTENING_RANGE_INTERVALS[range],
      ),
    ).toEqual(['28 days', '6 months', '12 months']);
  });

  it('round-trips a listen cursor in the studio-cursor shape', () => {
    const cursor = {
      playedAt: new Date('2026-10-20T08:00:00.123Z'),
      id: LISTEN_ID,
    };
    expect(decodeListenCursor(encodeListenCursor(cursor))).toEqual(cursor);
    expect(encodeListenCursor(cursor)).toBe(
      Buffer.from(`2026-10-20T08:00:00.123Z|${LISTEN_ID}`).toString(
        'base64url',
      ),
    );
  });

  it.each([undefined, '', 'garbage'])(
    'reads %p as the first page',
    (cursor) => {
      expect(decodeListenCursor(cursor)).toBeNull();
    },
  );

  it('pages by thirty, shows ten and keeps thirteen months', () => {
    expect([
      STUDIO_LISTENS_PER_PAGE,
      STUDIO_LISTENING_TOP_SHOWN,
      STUDIO_LISTENING_RETENTION_INTERVAL,
    ]).toEqual([30, 10, '13 months']);
  });
});

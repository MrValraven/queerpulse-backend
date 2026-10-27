import {
  STUDIO_PLACEMENT_TRACKS_SHOWN,
  STUDIO_PLACEMENTS_PER_PAGE,
  decodePlacementCursor,
  encodePlacementCursor,
} from './studio-placements';

const PLAYLIST_ID = '8a000000-0000-4000-8000-000000000001';

describe('Studio placements', () => {
  it('round-trips a cursor', () => {
    const cursor = {
      latestAddedAt: new Date('2026-10-20T08:00:00.123Z'),
      playlistId: PLAYLIST_ID,
    };
    expect(decodePlacementCursor(encodePlacementCursor(cursor))).toEqual(
      cursor,
    );
  });

  it.each([
    undefined,
    '',
    'garbage',
    Buffer.from('2026-10-20T08:00:00.000Z|not-a-uuid').toString('base64url'),
  ])('reads %p as the first page', (cursor) => {
    expect(decodePlacementCursor(cursor)).toBeNull();
  });

  it('pages by twenty and shows five tracks', () => {
    expect(STUDIO_PLACEMENTS_PER_PAGE).toBe(20);
    expect(STUDIO_PLACEMENT_TRACKS_SHOWN).toBe(5);
  });
});

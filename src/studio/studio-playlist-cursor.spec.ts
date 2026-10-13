import {
  decodePlaylistCursor,
  encodePlaylistCursor,
} from './studio-playlist-cursor';

const PLAYLIST_ID = '8d000000-0000-4000-8000-000000000001';

describe('Studio playlist cursor', () => {
  it('round-trips the update time and id', () => {
    const updatedAt = new Date('2026-10-13T12:34:56.789Z');
    expect(
      decodePlaylistCursor(
        encodePlaylistCursor({ updatedAt, id: PLAYLIST_ID }),
      ),
    ).toEqual({ updatedAt, id: PLAYLIST_ID });
  });

  it.each([undefined, '', 'not a cursor'])(
    'reads %p as the first page',
    (cursor) => {
      expect(decodePlaylistCursor(cursor)).toBeNull();
    },
  );
});

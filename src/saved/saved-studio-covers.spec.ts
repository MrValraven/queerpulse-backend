import { EntityManager } from 'typeorm';
import { SavedItem, SavedKind } from './entities/saved-item.entity';
import { toResolvedSavedItemDTOs } from './saved-response';
import {
  SAVED_PLAYLIST_COVERS_SQL,
  SAVED_RELEASE_COVERS_SQL,
  savedStudioCoverUrls,
} from './saved-studio-covers';

const VIEWER_ID = 'c8000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'c8000000-0000-4000-8000-000000000002';
const PLAYLIST_ID = 'c8000000-0000-4000-8000-000000000003';
const LOST_RELEASE_ID = 'c8000000-0000-4000-8000-000000000004';
const RELEASE_COVER = 'https://images.example.org/release.jpg';
const PLAYLIST_COVER = 'https://images.example.org/playlist.jpg';

const savedRow = (subjectType: SavedKind, subjectId: string): SavedItem => ({
  id: `row-${subjectId}`,
  userId: VIEWER_ID,
  subjectType,
  subjectId,
  title: 'Saved',
  href: null,
  meta: null,
  description: null,
  readTime: null,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
});

describe('savedStudioCoverUrls', () => {
  const rows = [
    savedRow(SavedKind.StudioRelease, RELEASE_ID),
    savedRow(SavedKind.StudioPlaylist, PLAYLIST_ID),
    savedRow(SavedKind.StudioRelease, LOST_RELEASE_ID),
    savedRow(SavedKind.Film, 'pride-1994'),
  ];
  const availableRefs = new Set([
    `studio_release:${RELEASE_ID}`,
    `studio_playlist:${PLAYLIST_ID}`,
    'film:pride-1994',
  ]);
  let query: jest.Mock;
  let manager: EntityManager;

  beforeEach(() => {
    query = jest.fn((sql: string) =>
      Promise.resolve(
        sql === SAVED_RELEASE_COVERS_SQL
          ? [{ subject_id: RELEASE_ID, cover_key: RELEASE_COVER }]
          : [{ subject_id: PLAYLIST_ID, cover_key: PLAYLIST_COVER }],
      ),
    );
    manager = { query } as unknown as EntityManager;
  });

  it('reads covers for available Studio releases and playlists only, in two queries', async () => {
    const covers = await savedStudioCoverUrls(
      manager,
      rows,
      availableRefs,
      VIEWER_ID,
    );
    expect(query).toHaveBeenCalledWith(SAVED_RELEASE_COVERS_SQL, [
      [RELEASE_ID],
    ]);
    expect(query).toHaveBeenCalledWith(SAVED_PLAYLIST_COVERS_SQL, [
      VIEWER_ID,
      [PLAYLIST_ID],
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(covers.get(`studio_release:${RELEASE_ID}`)).toBe(RELEASE_COVER);
    expect(covers.get(`studio_playlist:${PLAYLIST_ID}`)).toBe(PLAYLIST_COVER);
  });

  it('reads nothing for a page without an available Studio release or playlist', async () => {
    const covers = await savedStudioCoverUrls(
      manager,
      [savedRow(SavedKind.Film, 'pride-1994')],
      availableRefs,
      VIEWER_ID,
    );
    expect(query).not.toHaveBeenCalled();
    expect(covers.size).toBe(0);
  });

  it("takes a playlist's first playable cover under the viewer's blocks", () => {
    expect(SAVED_PLAYLIST_COVERS_SQL).toContain(
      'DISTINCT ON ("entry"."playlist_id")',
    );
    expect(SAVED_PLAYLIST_COVERS_SQL).toContain(
      'ORDER BY "entry"."playlist_id", "entry"."position" ASC',
    );
    expect(SAVED_PLAYLIST_COVERS_SQL).toContain(
      'FROM "blocks" "saved_cover_block"',
    );
  });

  it('puts coverUrl on Studio release and playlist rows only, null when unavailable', async () => {
    const covers = await savedStudioCoverUrls(
      manager,
      rows,
      availableRefs,
      VIEWER_ID,
    );
    const items = toResolvedSavedItemDTOs(
      rows,
      availableRefs,
      new Set(),
      covers,
    );
    expect(items.map((item) => item.coverUrl)).toEqual([
      RELEASE_COVER,
      PLAYLIST_COVER,
      null,
      undefined,
    ]);
    expect(items[3]).not.toHaveProperty('coverUrl');
  });
});

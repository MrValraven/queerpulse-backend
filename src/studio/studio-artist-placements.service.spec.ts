import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  PLACEMENT_PAGE_SQL,
  PLACEMENT_TRACKS_SQL,
  StudioArtistPlacementsService,
} from './studio-artist-placements.service';
import { StudioOwnershipService } from './studio-ownership.service';
import {
  decodePlacementCursor,
  encodePlacementCursor,
} from './studio-placements';
import type { StudioPlaylistCard } from './studio-playlist-response';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';

const VIEWER_ID = 'fa000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'fa000000-0000-4000-8000-000000000002';
const FIRST_PLAYLIST_ID = 'fa000000-0000-4000-8000-000000000101';
const SECOND_PLAYLIST_ID = 'fa000000-0000-4000-8000-000000000102';
const CURSOR_PLAYLIST_ID = 'fa000000-0000-4000-8000-000000000199';
const TRACK_ONE = 'fa000000-0000-4000-8000-000000000201';
const TRACK_TWO = 'fa000000-0000-4000-8000-000000000202';
const RELEASE_ID = 'fa000000-0000-4000-8000-000000000301';

const FIRST_CARD = {
  id: FIRST_PLAYLIST_ID,
  name: 'Morning run',
} as unknown as StudioPlaylistCard;
const SECOND_CARD = {
  id: SECOND_PLAYLIST_ID,
  name: 'Late shift',
} as unknown as StudioPlaylistCard;

interface PageRow {
  playlist_id: string;
  latest_added_at: Date;
  track_count: number;
}

const DEFAULT_PAGE_ROWS: PageRow[] = [
  {
    playlist_id: FIRST_PLAYLIST_ID,
    latest_added_at: new Date('2026-10-20T08:00:00.123Z'),
    track_count: 1,
  },
  {
    playlist_id: SECOND_PLAYLIST_ID,
    latest_added_at: new Date('2026-10-19T08:00:00.000Z'),
    track_count: 2,
  },
];

const DEFAULT_TRACK_ROWS = [
  {
    playlist_id: FIRST_PLAYLIST_ID,
    track_id: TRACK_ONE,
    title: 'Night bus',
    release_id: RELEASE_ID,
  },
  {
    playlist_id: SECOND_PLAYLIST_ID,
    track_id: TRACK_TWO,
    title: 'Ferry lights',
    release_id: RELEASE_ID,
  },
  {
    playlist_id: SECOND_PLAYLIST_ID,
    track_id: TRACK_ONE,
    title: 'Night bus',
    release_id: RELEASE_ID,
  },
];

/** `count` page rows, newest first, one second apart. */
function pageRowsOf(count: number): PageRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    playlist_id: `fa000000-0000-4000-8000-${String(1000 + index).padStart(12, '0')}`,
    latest_added_at: new Date(Date.UTC(2026, 9, 20, 8, 0, 59 - index, 500)),
    track_count: 1,
  }));
}

describe('StudioArtistPlacementsService', () => {
  let query: jest.Mock;
  let ownership: { isPersonaMember: jest.Mock };
  let playlistReads: { cardsForPlaylistIds: jest.Mock };
  let service: StudioArtistPlacementsService;

  const answerQueries = (pageRows: PageRow[], trackRows: unknown[]) => {
    query.mockImplementation((sql: string) =>
      Promise.resolve(sql === PLACEMENT_PAGE_SQL ? pageRows : trackRows),
    );
  };

  beforeEach(() => {
    query = jest.fn();
    answerQueries(DEFAULT_PAGE_ROWS, DEFAULT_TRACK_ROWS);
    ownership = { isPersonaMember: jest.fn().mockResolvedValue(true) };
    playlistReads = {
      cardsForPlaylistIds: jest.fn((_viewerId: string, playlistIds: string[]) =>
        Promise.resolve(
          new Map(
            playlistIds.map((playlistId) => [
              playlistId,
              playlistId === FIRST_PLAYLIST_ID
                ? FIRST_CARD
                : playlistId === SECOND_PLAYLIST_ID
                  ? SECOND_CARD
                  : ({ id: playlistId } as unknown as StudioPlaylistCard),
            ]),
          ),
        ),
      ),
    };
    service = new StudioArtistPlacementsService(
      { query } as unknown as DataSource,
      ownership as unknown as StudioOwnershipService,
      playlistReads as unknown as StudioPlaylistReadsService,
    );
  });

  it('answers 404 Artist not found to a member who does not run the persona, before reading anything', async () => {
    ownership.isPersonaMember.mockResolvedValue(false);
    await expect(
      service.listPlacements(VIEWER_ID, PERSONA_ID, undefined),
    ).rejects.toThrow(new NotFoundException('Artist not found'));
    expect(ownership.isPersonaMember).toHaveBeenCalledWith(
      VIEWER_ID,
      PERSONA_ID,
    );
    expect(query).not.toHaveBeenCalled();
    expect(playlistReads.cardsForPlaylistIds).not.toHaveBeenCalled();
  });

  it('builds each row from the card the playlist reads service gives this viewer', async () => {
    const page = await service.listPlacements(VIEWER_ID, PERSONA_ID, undefined);

    expect(playlistReads.cardsForPlaylistIds).toHaveBeenCalledWith(VIEWER_ID, [
      FIRST_PLAYLIST_ID,
      SECOND_PLAYLIST_ID,
    ]);
    expect(page.items[0]).toEqual({
      playlist: FIRST_CARD,
      tracks: [{ id: TRACK_ONE, title: 'Night bus', releaseId: RELEASE_ID }],
      trackCount: 1,
      latestAddedAt: '2026-10-20T08:00:00.123Z',
    });
    expect(page.items[1]).toEqual({
      playlist: SECOND_CARD,
      tracks: [
        { id: TRACK_TWO, title: 'Ferry lights', releaseId: RELEASE_ID },
        { id: TRACK_ONE, title: 'Night bus', releaseId: RELEASE_ID },
      ],
      trackCount: 2,
      latestAddedAt: '2026-10-19T08:00:00.000Z',
    });
    expect(page.nextCursor).toBeNull();
  });

  it('asks for twenty-one rows and five tracks per playlist', async () => {
    await service.listPlacements(VIEWER_ID, PERSONA_ID, undefined);

    expect(query).toHaveBeenCalledWith(PLACEMENT_PAGE_SQL, [
      PERSONA_ID,
      null,
      null,
      21,
    ]);
    expect(query).toHaveBeenCalledWith(PLACEMENT_TRACKS_SQL, [
      PERSONA_ID,
      [FIRST_PLAYLIST_ID, SECOND_PLAYLIST_ID],
      5,
    ]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('hands back a cursor only when a 21st row exists', async () => {
    const fullRows = pageRowsOf(21);
    answerQueries(fullRows, []);

    const fullPage = await service.listPlacements(
      VIEWER_ID,
      PERSONA_ID,
      undefined,
    );

    expect(fullPage.items).toHaveLength(20);
    expect(fullPage.items[19]!.playlist.id).toBe(fullRows[19]!.playlist_id);
    expect(fullPage.nextCursor).toBe(
      encodePlacementCursor({
        latestAddedAt: fullRows[19]!.latest_added_at,
        playlistId: fullRows[19]!.playlist_id,
      }),
    );
    expect(decodePlacementCursor(fullPage.nextCursor!)).toEqual({
      latestAddedAt: fullRows[19]!.latest_added_at,
      playlistId: fullRows[19]!.playlist_id,
    });
    expect(playlistReads.cardsForPlaylistIds).toHaveBeenLastCalledWith(
      VIEWER_ID,
      fullRows.slice(0, 20).map((row) => row.playlist_id),
    );

    answerQueries(pageRowsOf(20), []);
    const lastPage = await service.listPlacements(
      VIEWER_ID,
      PERSONA_ID,
      undefined,
    );

    expect(lastPage.items).toHaveLength(20);
    expect(lastPage.nextCursor).toBeNull();
  });

  it('reads a malformed cursor as the first page', async () => {
    await service.listPlacements(VIEWER_ID, PERSONA_ID, 'not-a-cursor');

    expect(query).toHaveBeenCalledWith(PLACEMENT_PAGE_SQL, [
      PERSONA_ID,
      null,
      null,
      21,
    ]);
  });

  it('passes the decoded cursor position to the page query', async () => {
    const cursorDate = new Date('2026-10-18T12:30:00.456Z');
    const cursor = encodePlacementCursor({
      latestAddedAt: cursorDate,
      playlistId: CURSOR_PLAYLIST_ID,
    });

    await service.listPlacements(VIEWER_ID, PERSONA_ID, cursor);

    expect(query).toHaveBeenCalledWith(PLACEMENT_PAGE_SQL, [
      PERSONA_ID,
      cursorDate,
      CURSOR_PLAYLIST_ID,
      21,
    ]);
  });

  it('skips a row whose card the reads service drops', async () => {
    playlistReads.cardsForPlaylistIds.mockResolvedValue(
      new Map([[FIRST_PLAYLIST_ID, FIRST_CARD]]),
    );

    const page = await service.listPlacements(VIEWER_ID, PERSONA_ID, undefined);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.playlist).toBe(FIRST_CARD);
    expect(page.nextCursor).toBeNull();
  });

  it('answers an empty page without the tracks query or the cards', async () => {
    answerQueries([], DEFAULT_TRACK_ROWS);

    const page = await service.listPlacements(VIEWER_ID, PERSONA_ID, undefined);

    expect(page).toEqual({ items: [], nextCursor: null });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalledWith(
      PLACEMENT_TRACKS_SQL,
      expect.anything(),
    );
    expect(playlistReads.cardsForPlaylistIds).not.toHaveBeenCalled();
  });

  it('gives a playlist with no shown track rows an empty track list', async () => {
    answerQueries([DEFAULT_PAGE_ROWS[0]!], []);

    const page = await service.listPlacements(VIEWER_ID, PERSONA_ID, undefined);

    expect(page.items).toEqual([
      {
        playlist: FIRST_CARD,
        tracks: [],
        trackCount: 1,
        latestAddedAt: '2026-10-20T08:00:00.123Z',
      },
    ]);
  });

  it('puts no member or owner field on a placement', async () => {
    const page = await service.listPlacements(VIEWER_ID, PERSONA_ID, undefined);

    for (const placement of page.items) {
      expect(Object.keys(placement).sort()).toEqual([
        'latestAddedAt',
        'playlist',
        'trackCount',
        'tracks',
      ]);
      for (const track of placement.tracks) {
        expect(Object.keys(track).sort()).toEqual(['id', 'releaseId', 'title']);
      }
    }
  });

  it('keeps every SQL parameter positional', () => {
    expect(PLACEMENT_PAGE_SQL).toContain('LIMIT $4');
    expect(PLACEMENT_PAGE_SQL).not.toMatch(/(?<!:):[a-zA-Z]/);
    expect(PLACEMENT_TRACKS_SQL).toContain('"ranked"."track_rank" <= $3');
    expect(PLACEMENT_TRACKS_SQL).not.toMatch(/(?<!:):[a-zA-Z]/);
  });
});

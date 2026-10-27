import { DataSource } from 'typeorm';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import {
  decodeListenCursor,
  encodeListenCursor,
} from './studio-listening-history';
import {
  CLEAR_LISTENS_SQL,
  LISTENING_TOTALS_SQL,
  RECENT_LISTENS_SQL,
  StudioListeningHistoryService,
  TOP_ARTISTS_SQL,
  TOP_TRACKS_SQL,
} from './studio-listening-history.service';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import {
  StudioArtistRef,
  StudioReleaseCard,
  toStudioTrackSummary,
} from './studio-response';
import { STUDIO_ARTIST_PERSONA_KINDS } from './studio.constants';

const USER_ID = 'fb000000-0000-4000-8000-000000000001';
const ARTIST_ID = 'fb000000-0000-4000-8000-000000000002';
const RELEASE_ID = 'fb000000-0000-4000-8000-000000000003';
const TRACK_ID = 'fb000000-0000-4000-8000-000000000004';
const DROPPED_TRACK_ID = 'fb000000-0000-4000-8000-000000000005';
const CURSOR_LISTEN_ID = 'fb000000-0000-4000-8000-000000000006';

const trackFixture: Partial<StudioTrack> = {
  id: TRACK_ID,
  releaseId: RELEASE_ID,
  position: 1,
  title: 'Night bus',
  audioKey: 'studio-audio/a/b.mp3',
  audioContentType: 'audio/mpeg',
  durationSeconds: 200,
  isExplicit: false,
  publishedAt: null,
  notes: null,
  contentWarnings: [],
  staffContentWarnings: [],
  withheldAt: null,
};
const TRACK = trackFixture as StudioTrack;
const TRACK_SUMMARY = toStudioTrackSummary(TRACK);

const releaseCardFixture: Partial<StudioReleaseCard> = {
  id: RELEASE_ID,
  title: 'Lisbon at four',
};
const RELEASE_CARD = releaseCardFixture as StudioReleaseCard;

const ARTIST_REF: StudioArtistRef = {
  id: ARTIST_ID,
  handle: 'harbour-lights',
  name: 'Harbour Lights',
  kind: 'musician',
  avatarUrl: null,
};

const TOTALS_ROWS = [{ total_listens: 3, listening_days: 2 }];
const ARTIST_ROWS = [
  {
    artist_id: ARTIST_ID,
    artist_handle: 'harbour-lights',
    artist_display_name: 'Harbour Lights',
    artist_kind: 'musician',
    artist_avatar_url: null,
    listen_count: 2,
    latest_played_at: new Date('2026-10-26T08:00:00.000Z'),
  },
];
const TRACK_ROWS = [
  {
    track_id: TRACK_ID,
    listen_count: 2,
    latest_played_at: new Date('2026-10-26T08:00:00.000Z'),
  },
];

interface RecentRow {
  id: string;
  track_id: string;
  played_at: Date;
}

/** `count` listens of one track, newest first, one second apart. */
function recentRowsOf(count: number): RecentRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `fb000000-0000-4000-8000-${String(1000 + index).padStart(12, '0')}`,
    track_id: TRACK_ID,
    played_at: new Date(Date.UTC(2026, 9, 26, 8, 59, 59 - index, 250)),
  }));
}

describe('StudioListeningHistoryService', () => {
  let query: jest.Mock;
  let playlistReads: { playableTracks: jest.Mock };
  let catalog: { cardsByReleaseId: jest.Mock };
  let service: StudioListeningHistoryService;

  const answerQueries = (rowsBySql: Map<string, unknown[]>) => {
    query.mockImplementation((sql: string) =>
      Promise.resolve(rowsBySql.get(sql) ?? []),
    );
  };

  beforeEach(() => {
    query = jest.fn();
    answerQueries(
      new Map<string, unknown[]>([
        [LISTENING_TOTALS_SQL, TOTALS_ROWS],
        [TOP_ARTISTS_SQL, ARTIST_ROWS],
        [TOP_TRACKS_SQL, TRACK_ROWS],
      ]),
    );
    playlistReads = {
      playableTracks: jest.fn((_userId: string, trackIds: string[]) =>
        Promise.resolve(
          new Map(
            trackIds
              .filter((trackId) => trackId === TRACK_ID)
              .map((trackId) => [trackId, TRACK]),
          ),
        ),
      ),
    };
    catalog = {
      cardsByReleaseId: jest.fn((releaseIds: string[]) =>
        Promise.resolve(
          new Map(releaseIds.map((releaseId) => [releaseId, RELEASE_CARD])),
        ),
      ),
    };
    service = new StudioListeningHistoryService(
      { query } as unknown as DataSource,
      playlistReads as unknown as StudioPlaylistReadsService,
      catalog as unknown as StudioCatalogService,
    );
  });

  it.each([
    ['4w', '28 days'],
    ['6m', '6 months'],
    ['12m', '12 months'],
  ] as const)('reads the %s window', async (range, interval) => {
    await service.getSummary(USER_ID, range);

    expect(query).toHaveBeenCalledWith(LISTENING_TOTALS_SQL, [
      USER_ID,
      interval,
    ]);
    expect(query).toHaveBeenCalledWith(TOP_ARTISTS_SQL, [
      USER_ID,
      interval,
      [...STUDIO_ARTIST_PERSONA_KINDS],
      10,
    ]);
    expect(query).toHaveBeenCalledWith(TOP_TRACKS_SQL, [USER_ID, interval, 10]);
  });

  it('maps totals, top artists and top tracks in query order with unfloored counts', async () => {
    const summary = await service.getSummary(USER_ID, '4w');

    expect(summary).toEqual({
      range: '4w',
      totalListens: 3,
      listeningDays: 2,
      topArtists: [{ artist: ARTIST_REF, listens: 2 }],
      topTracks: [
        { track: { ...TRACK_SUMMARY, release: RELEASE_CARD }, listens: 2 },
      ],
    });
    expect(playlistReads.playableTracks).toHaveBeenCalledWith(USER_ID, [
      TRACK_ID,
    ]);
    expect(catalog.cardsByReleaseId).toHaveBeenCalledWith([RELEASE_ID]);
  });

  it('keeps counts below the owner floor for the caller', async () => {
    answerQueries(
      new Map<string, unknown[]>([
        [LISTENING_TOTALS_SQL, [{ total_listens: '1', listening_days: '1' }]],
        [TOP_ARTISTS_SQL, [{ ...ARTIST_ROWS[0], listen_count: '1' }]],
        [TOP_TRACKS_SQL, [{ ...TRACK_ROWS[0], listen_count: '1' }]],
      ]),
    );

    const summary = await service.getSummary(USER_ID, '6m');

    expect([
      summary.totalListens,
      summary.listeningDays,
      ...summary.topArtists.map((topArtist) => topArtist.listens),
      ...summary.topTracks.map((topTrack) => topTrack.listens),
    ]).toEqual([1, 1, 1, 1]);
  });

  it('leaves out a top track the playlist rule drops', async () => {
    answerQueries(
      new Map<string, unknown[]>([
        [LISTENING_TOTALS_SQL, TOTALS_ROWS],
        [TOP_ARTISTS_SQL, ARTIST_ROWS],
        [
          TOP_TRACKS_SQL,
          [
            {
              track_id: DROPPED_TRACK_ID,
              listen_count: 5,
              latest_played_at: new Date('2026-10-26T09:00:00.000Z'),
            },
            ...TRACK_ROWS,
          ],
        ],
      ]),
    );

    const summary = await service.getSummary(USER_ID, '4w');

    expect(playlistReads.playableTracks).toHaveBeenCalledWith(USER_ID, [
      DROPPED_TRACK_ID,
      TRACK_ID,
    ]);
    expect(
      summary.topTracks.map((topTrack) => [
        topTrack.track.id,
        topTrack.listens,
      ]),
    ).toEqual([[TRACK_ID, 2]]);
  });

  it('answers zeros and empty lists when the window holds no listen', async () => {
    answerQueries(
      new Map<string, unknown[]>([
        [LISTENING_TOTALS_SQL, [{ total_listens: 0, listening_days: 0 }]],
      ]),
    );

    const summary = await service.getSummary(USER_ID, '12m');

    expect(summary).toEqual({
      range: '12m',
      totalListens: 0,
      listeningDays: 0,
      topArtists: [],
      topTracks: [],
    });
    expect(playlistReads.playableTracks).not.toHaveBeenCalled();
    expect(catalog.cardsByReleaseId).not.toHaveBeenCalled();
  });

  it('pages recent listens by thirty with a cursor only when a 31st row exists', async () => {
    const rows = recentRowsOf(31);
    answerQueries(new Map<string, unknown[]>([[RECENT_LISTENS_SQL, rows]]));

    const page = await service.listRecent(USER_ID, undefined);

    expect(query).toHaveBeenCalledWith(RECENT_LISTENS_SQL, [
      USER_ID,
      null,
      null,
      31,
    ]);
    expect(page.items.map((item) => [item.id, item.playedAt])).toEqual(
      rows.slice(0, 30).map((row) => [row.id, row.played_at.toISOString()]),
    );
    const thirtiethRow = rows[29];
    expect(decodeListenCursor(page.nextCursor ?? undefined)).toEqual({
      playedAt: thirtiethRow?.played_at,
      id: thirtiethRow?.id,
    });
  });

  it('answers no cursor on a page of thirty or fewer', async () => {
    const rows = recentRowsOf(30);
    answerQueries(new Map<string, unknown[]>([[RECENT_LISTENS_SQL, rows]]));

    const page = await service.listRecent(USER_ID, undefined);

    expect(page.items).toHaveLength(30);
    expect(page.nextCursor).toBeNull();
  });

  it('reads the page after a cursor from its time and listen id', async () => {
    const cursorTime = new Date('2026-10-26T08:00:00.123Z');
    answerQueries(new Map<string, unknown[]>([[RECENT_LISTENS_SQL, []]]));

    const page = await service.listRecent(
      USER_ID,
      encodeListenCursor({ playedAt: cursorTime, id: CURSOR_LISTEN_ID }),
    );

    expect(query).toHaveBeenCalledWith(RECENT_LISTENS_SQL, [
      USER_ID,
      cursorTime,
      CURSOR_LISTEN_ID,
      31,
    ]);
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(playlistReads.playableTracks).not.toHaveBeenCalled();
  });

  it('reads a malformed cursor as the first page', async () => {
    answerQueries(new Map<string, unknown[]>([[RECENT_LISTENS_SQL, []]]));

    await service.listRecent(USER_ID, 'not-a-cursor');

    expect(query).toHaveBeenCalledWith(RECENT_LISTENS_SQL, [
      USER_ID,
      null,
      null,
      31,
    ]);
  });

  it('shows a listen the caller cannot play now with a null track', async () => {
    const playedAt = new Date('2026-10-26T08:00:00.500Z');
    const droppedPlayedAt = new Date('2026-10-26T07:00:00.000Z');
    const rows: RecentRow[] = [
      { id: CURSOR_LISTEN_ID, track_id: TRACK_ID, played_at: playedAt },
      {
        id: 'fb000000-0000-4000-8000-000000000007',
        track_id: DROPPED_TRACK_ID,
        played_at: droppedPlayedAt,
      },
    ];
    answerQueries(new Map<string, unknown[]>([[RECENT_LISTENS_SQL, rows]]));

    const page = await service.listRecent(USER_ID, undefined);

    expect(page).toEqual({
      items: [
        {
          id: CURSOR_LISTEN_ID,
          playedAt: playedAt.toISOString(),
          track: { ...TRACK_SUMMARY, release: RELEASE_CARD },
        },
        {
          id: 'fb000000-0000-4000-8000-000000000007',
          playedAt: droppedPlayedAt.toISOString(),
          track: null,
        },
      ],
      nextCursor: null,
    });
    expect(playlistReads.playableTracks).toHaveBeenCalledWith(USER_ID, [
      TRACK_ID,
      DROPPED_TRACK_ID,
    ]);
  });

  it('asks the playlist rule once for a track listened to twice on one page', async () => {
    answerQueries(
      new Map<string, unknown[]>([[RECENT_LISTENS_SQL, recentRowsOf(3)]]),
    );

    await service.listRecent(USER_ID, undefined);

    expect(playlistReads.playableTracks.mock.calls).toEqual([
      [USER_ID, [TRACK_ID]],
    ]);
  });

  it('clears the caller rows only', async () => {
    await service.clearHistory(USER_ID);

    expect(query.mock.calls).toEqual([[CLEAR_LISTENS_SQL, [USER_ID]]]);
  });

  it('spells the clear for the caller rows alone', () => {
    expect(CLEAR_LISTENS_SQL).toBe(
      'DELETE FROM "studio_listens" WHERE "user_id" = $1',
    );
  });
});

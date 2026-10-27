import { Repository } from 'typeorm';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { decodeStudioCursor, encodeStudioCursor } from './studio-cursor';
import { StudioLikedTracksService } from './studio-liked-tracks.service';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import { playableTrackSql } from './studio-playlist-visibility';
import { StudioReleaseCard } from './studio-response';
import { STUDIO_LIMITS } from './studio.constants';

const VIEWER_ID = 'e1000000-0000-4000-8000-000000000002';
const RELEASE_ID = 'e4000000-0000-4000-8000-000000000001';
const TRACK_A = 'e5000000-0000-4000-8000-00000000000a';
const TRACK_B = 'e5000000-0000-4000-8000-00000000000b';
const TRACK_C = 'e5000000-0000-4000-8000-00000000000c';
const SAVED_A = 'e6000000-0000-4000-8000-00000000000a';
const SAVED_B = 'e6000000-0000-4000-8000-00000000000b';
const SAVED_C = 'e6000000-0000-4000-8000-00000000000c';
const CURSOR_SAVED_ID = 'e6000000-0000-4000-8000-0000000000ff';

type WhereMock = jest.Mock<
  QueryBuilderMock,
  [predicate: string, parameters?: Record<string, unknown>]
>;

interface QueryBuilderMock {
  innerJoin: jest.Mock;
  select: jest.Mock;
  addSelect: jest.Mock;
  where: WhereMock;
  andWhere: WhereMock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  getRawMany: jest.Mock;
  getRawOne: jest.Mock;
  getCount: jest.Mock;
}

function queryBuilderMock(
  result: { raw?: unknown[]; rawOne?: unknown; count?: number } = {},
): QueryBuilderMock {
  const queryBuilder = {} as QueryBuilderMock;
  for (const method of [
    'innerJoin',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
  ] as const) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawMany = jest.fn().mockResolvedValue(result.raw ?? []);
  queryBuilder.getRawOne = jest
    .fn()
    .mockResolvedValue(
      result.rawOne ?? { track_count: 0, total_duration_seconds: 0 },
    );
  queryBuilder.getCount = jest.fn().mockResolvedValue(result.count ?? 0);
  return queryBuilder;
}

const predicatesOf = (queryBuilder: QueryBuilderMock): string[] => [
  ...queryBuilder.where.mock.calls.map(([predicate]) => predicate),
  ...queryBuilder.andWhere.mock.calls.map(([predicate]) => predicate),
];

const parametersOf = (
  queryBuilder: QueryBuilderMock,
): Record<string, unknown>[] => [
  ...queryBuilder.where.mock.calls.map(([, parameters]) => parameters ?? {}),
  ...queryBuilder.andWhere.mock.calls.map(([, parameters]) => parameters ?? {}),
];

interface LikedRowFixture {
  saved_id: string;
  subject_id: string;
  saved_title: string;
  created_at: Date;
  liked_at: Date;
}

const likedRow = (
  savedId: string,
  subjectId: string,
  minute: number,
): LikedRowFixture => ({
  saved_id: savedId,
  subject_id: subjectId,
  saved_title: `Saved ${subjectId.slice(-1)}`,
  created_at: new Date(
    `2026-10-14T09:${String(minute).padStart(2, '0')}:00.000Z`,
  ),
  liked_at: new Date(
    `2026-10-14T09:${String(minute).padStart(2, '0')}:00.000Z`,
  ),
});

const trackRow = (id: string, position: number): StudioTrack =>
  ({
    id,
    releaseId: RELEASE_ID,
    position,
    title: `Track ${position}`,
    audioKey: 'studio-audio/a/b.mp3',
    audioContentType: 'audio/mpeg',
    durationSeconds: 200,
    isExplicit: false,
  }) as StudioTrack;

const releaseCard = {
  id: RELEASE_ID,
  title: 'Lisbon at four',
} as StudioReleaseCard;

describe('StudioLikedTracksService', () => {
  let savedItems: { createQueryBuilder: jest.Mock };
  let tracks: { createQueryBuilder: jest.Mock };
  let playlistReads: {
    playableTracks: jest.Mock;
    withdrawnTrackIds: jest.Mock;
  };
  let catalog: { cardsByReleaseId: jest.Mock };
  let blockFilter: { excludeBlocked: jest.Mock };
  let service: StudioLikedTracksService;

  const queueBuilders = (
    repository: { createQueryBuilder: jest.Mock },
    builders: QueryBuilderMock[],
  ): void => {
    repository.createQueryBuilder.mockImplementation(
      () => builders.shift() ?? queryBuilderMock(),
    );
  };

  beforeEach(() => {
    savedItems = { createQueryBuilder: jest.fn(() => queryBuilderMock()) };
    tracks = { createQueryBuilder: jest.fn(() => queryBuilderMock()) };
    playlistReads = {
      playableTracks: jest.fn().mockResolvedValue(new Map()),
      withdrawnTrackIds: jest.fn().mockResolvedValue(new Set()),
    };
    catalog = {
      cardsByReleaseId: jest
        .fn()
        .mockResolvedValue(new Map([[RELEASE_ID, releaseCard]])),
    };
    blockFilter = {
      excludeBlocked: jest.fn((queryBuilder: QueryBuilderMock) => queryBuilder),
    };
    service = new StudioLikedTracksService(
      savedItems as unknown as Repository<SavedItem>,
      tracks as unknown as Repository<StudioTrack>,
      playlistReads as unknown as StudioPlaylistReadsService,
      catalog as unknown as StudioCatalogService,
      blockFilter as unknown as BlockFilterService,
    );
  });

  it('reads only the caller likes, newest first, as playable entries', async () => {
    const pageQuery = queryBuilderMock({
      raw: [likedRow(SAVED_A, TRACK_A, 30), likedRow(SAVED_B, TRACK_B, 10)],
    });
    queueBuilders(savedItems, [pageQuery]);
    playlistReads.playableTracks.mockResolvedValue(
      new Map([
        [TRACK_A, trackRow(TRACK_A, 1)],
        [TRACK_B, trackRow(TRACK_B, 2)],
      ]),
    );

    const page = await service.listLiked(VIEWER_ID, undefined);

    expect(pageQuery.where).toHaveBeenCalledWith(
      '"saved"."user_id" = :likedOwnerId',
      { likedOwnerId: VIEWER_ID },
    );
    expect(predicatesOf(pageQuery)).toContain(
      `"saved"."subject_type" = 'studio_track'`,
    );
    expect(pageQuery.orderBy).toHaveBeenCalledWith(
      `date_trunc('milliseconds', "saved"."created_at")`,
      'DESC',
    );
    expect(pageQuery.addOrderBy).toHaveBeenCalledWith('"saved"."id"', 'DESC');
    expect(pageQuery.limit).toHaveBeenCalledWith(
      STUDIO_LIMITS.likedTracksPerPage + 1,
    );
    expect(playlistReads.playableTracks).toHaveBeenCalledWith(VIEWER_ID, [
      TRACK_A,
      TRACK_B,
    ]);
    expect(page.items.map((entry) => entry.entryId)).toEqual([
      SAVED_A,
      SAVED_B,
    ]);
    expect(page.items.map((entry) => entry.position)).toEqual([1, 2]);
    expect(page.items[0]).toEqual(
      expect.objectContaining({
        trackId: TRACK_A,
        savedTitle: 'Saved a',
        isAvailable: true,
        addedAt: '2026-10-14T09:30:00.000Z',
      }),
    );
    expect(page.items[0]?.track).toEqual(
      expect.objectContaining({ id: TRACK_A, release: releaseCard }),
    );
    expect(page.items[0]).not.toHaveProperty('unavailableReason');
    expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
    expect(JSON.stringify(page)).not.toContain(VIEWER_ID);
  });

  it('pages by keyset and continues the positions after the cursor', async () => {
    const cursorLikedAt = new Date('2026-10-14T10:00:00.000Z');
    const cursor = encodeStudioCursor({
      publishedAt: cursorLikedAt,
      id: CURSOR_SAVED_ID,
    });
    const pageQuery = queryBuilderMock({
      raw: [likedRow(SAVED_A, TRACK_A, 30), likedRow(SAVED_B, TRACK_B, 10)],
    });
    const countQuery = queryBuilderMock({ count: 100 });
    queueBuilders(savedItems, [pageQuery, countQuery]);

    const page = await service.listLiked(VIEWER_ID, cursor);

    expect(predicatesOf(pageQuery)).toContainEqual(
      expect.stringMatching(
        /\(date_trunc\('milliseconds', "saved"\."created_at"\), "saved"\."id"\) < \(:cursorLikedAt, :cursorId\)/,
      ),
    );
    expect(parametersOf(pageQuery)).toContainEqual({
      cursorLikedAt,
      cursorId: CURSOR_SAVED_ID,
    });
    expect(countQuery.where).toHaveBeenCalledWith(
      '"saved"."user_id" = :likedOwnerId',
      { likedOwnerId: VIEWER_ID },
    );
    expect(predicatesOf(countQuery)).toContainEqual(
      expect.stringContaining('>= (:cursorLikedAt, :cursorId)'),
    );
    expect(page.items.map((entry) => entry.position)).toEqual([101, 102]);
  });

  it('reads a malformed cursor as the first page', async () => {
    const pageQuery = queryBuilderMock({
      raw: [likedRow(SAVED_A, TRACK_A, 30)],
    });
    queueBuilders(savedItems, [pageQuery]);

    const page = await service.listLiked(VIEWER_ID, 'not-a-cursor');

    expect(savedItems.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(predicatesOf(pageQuery)).not.toContainEqual(
      expect.stringContaining(':cursorId'),
    );
    expect(page.items.map((entry) => entry.position)).toEqual([1]);
  });

  it('answers a next cursor at the last row of a full page', async () => {
    const pageSize = STUDIO_LIMITS.likedTracksPerPage;
    const rows = Array.from({ length: pageSize + 1 }, (_unused, index) => ({
      ...likedRow(
        `e6000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        TRACK_A,
        0,
      ),
      liked_at: new Date(Date.UTC(2026, 9, 14, 9, 0, 0, pageSize + 1 - index)),
    }));
    queueBuilders(savedItems, [queryBuilderMock({ raw: rows })]);

    const page = await service.listLiked(VIEWER_ID, undefined);

    expect(page.items).toHaveLength(pageSize);
    expect(page.pageInfo.hasMore).toBe(true);
    const lastPageRow = rows[pageSize - 1];
    expect(decodeStudioCursor(page.pageInfo.nextCursor ?? undefined)).toEqual({
      publishedAt: lastPageRow?.liked_at,
      id: lastPageRow?.saved_id,
    });
  });

  it('keeps an unavailable like with its track id and saved title', async () => {
    queueBuilders(savedItems, [
      queryBuilderMock({
        raw: [
          likedRow(SAVED_A, TRACK_A, 30),
          likedRow(SAVED_B, TRACK_B, 20),
          likedRow(SAVED_C, TRACK_C, 10),
        ],
      }),
    ]);
    playlistReads.playableTracks.mockResolvedValue(
      new Map([[TRACK_A, trackRow(TRACK_A, 1)]]),
    );
    playlistReads.withdrawnTrackIds.mockResolvedValue(new Set([TRACK_B]));

    const page = await service.listLiked(VIEWER_ID, undefined);

    expect(playlistReads.withdrawnTrackIds).toHaveBeenCalledWith(VIEWER_ID, [
      TRACK_B,
      TRACK_C,
    ]);
    expect(page.items[1]).toEqual({
      entryId: SAVED_B,
      position: 2,
      addedAt: '2026-10-14T09:20:00.000Z',
      isAvailable: false,
      track: null,
      unavailableReason: 'withdrawn',
      trackId: TRACK_B,
      savedTitle: 'Saved b',
    });
    expect(page.items[2]).toEqual(
      expect.objectContaining({
        isAvailable: false,
        track: null,
        trackId: TRACK_C,
        savedTitle: 'Saved c',
      }),
    );
    expect(page.items[2]).not.toHaveProperty('unavailableReason');
  });

  it('answers a like whose subject is not a uuid as unavailable without a track query', async () => {
    queueBuilders(savedItems, [
      queryBuilderMock({ raw: [likedRow(SAVED_A, 'not-a-uuid', 30)] }),
    ]);

    const page = await service.listLiked(VIEWER_ID, undefined);

    expect(playlistReads.playableTracks).not.toHaveBeenCalled();
    expect(playlistReads.withdrawnTrackIds).not.toHaveBeenCalled();
    expect(catalog.cardsByReleaseId).not.toHaveBeenCalled();
    expect(page.items).toEqual([
      expect.objectContaining({
        entryId: SAVED_A,
        isAvailable: false,
        track: null,
        trackId: 'not-a-uuid',
      }),
    ]);
    expect(page.items[0]).not.toHaveProperty('unavailableReason');
  });

  it('answers an empty page with zero totals', async () => {
    queueBuilders(savedItems, [queryBuilderMock()]);

    const page = await service.listLiked(VIEWER_ID, undefined);

    expect(page).toEqual({
      items: [],
      pageInfo: { hasMore: false, nextCursor: null },
      trackCount: 0,
      totalDurationSeconds: 0,
    });
    expect(playlistReads.playableTracks).not.toHaveBeenCalled();
  });

  it('counts playable likes under the playability rule and the block filter', async () => {
    queueBuilders(savedItems, [queryBuilderMock()]);
    const statsQuery = queryBuilderMock({
      rawOne: { track_count: '3', total_duration_seconds: '612' },
    });
    queueBuilders(tracks, [statsQuery]);

    const page = await service.listLiked(VIEWER_ID, undefined);

    expect(predicatesOf(statsQuery)).toContain(
      playableTrackSql('track', 'release', 'persona'),
    );
    const likedPredicate = predicatesOf(statsQuery).find((predicate) =>
      predicate.includes('"saved_item" "liked"'),
    );
    // Driven from the likes: an `IN` probe on the track primary key.
    expect(likedPredicate).toMatch(/^"track"\."id" IN \(\s*SELECT CASE/);
    expect(likedPredicate).toContain(
      `WHEN "liked"."subject_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    );
    expect(likedPredicate).toContain('THEN lower("liked"."subject_id")::uuid');
    expect(likedPredicate).not.toContain('::text');
    expect(likedPredicate).toContain('"liked"."user_id" = :likedOwnerId');
    expect(likedPredicate).toContain(`"liked"."subject_type" = 'studio_track'`);
    expect(parametersOf(statsQuery)).toContainEqual({
      likedOwnerId: VIEWER_ID,
    });
    expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
      statsQuery,
      VIEWER_ID,
      '"persona"."user_id"',
    );
    expect(page.trackCount).toBe(3);
    expect(page.totalDurationSeconds).toBe(612);
  });

  it('skips the totals on a cursor page and answers them as zero', async () => {
    const cursor = encodeStudioCursor({
      publishedAt: new Date('2026-10-14T10:00:00.000Z'),
      id: CURSOR_SAVED_ID,
    });
    queueBuilders(savedItems, [
      queryBuilderMock({ raw: [likedRow(SAVED_A, TRACK_A, 30)] }),
      queryBuilderMock({ count: 100 }),
    ]);

    const page = await service.listLiked(VIEWER_ID, cursor);

    expect(tracks.createQueryBuilder).not.toHaveBeenCalled();
    expect(blockFilter.excludeBlocked).not.toHaveBeenCalled();
    expect(page.trackCount).toBe(0);
    expect(page.totalDurationSeconds).toBe(0);
  });

  it('resolves an uppercase uuid like and answers its stored track id', async () => {
    queueBuilders(savedItems, [
      queryBuilderMock({
        raw: [likedRow(SAVED_A, TRACK_A.toUpperCase(), 30)],
      }),
    ]);
    playlistReads.playableTracks.mockResolvedValue(
      new Map([[TRACK_A, trackRow(TRACK_A, 1)]]),
    );

    const page = await service.listLiked(VIEWER_ID, undefined);

    expect(playlistReads.playableTracks).toHaveBeenCalledWith(VIEWER_ID, [
      TRACK_A,
    ]);
    expect(page.items[0]).toEqual(
      expect.objectContaining({
        trackId: TRACK_A.toUpperCase(),
        isAvailable: true,
      }),
    );
  });
  describe('likedAmong', () => {
    it('answers which named tracks the caller has liked, on any page', async () => {
      const builder = queryBuilderMock({
        raw: [{ subject_id: TRACK_A.toUpperCase() }],
      });
      queueBuilders(savedItems, [builder]);

      const result = await service.likedAmong(VIEWER_ID, [TRACK_A, TRACK_B]);

      expect(result).toEqual({ likedTrackIds: [TRACK_A] });
      expect(parametersOf(builder)).toContainEqual({
        lookupIds: [TRACK_A, TRACK_B],
      });
      expect(parametersOf(builder)).toContainEqual({ likedOwnerId: VIEWER_ID });
    });
  });
});

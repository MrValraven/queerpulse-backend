import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { StorageService } from '../storage/storage.service';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofileFollowersService } from '../subprofiles/subprofile-followers.service';
import {
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { encodeStudioCursor } from './studio-cursor';
import { StudioOwnershipService } from './studio-ownership.service';

const VIEWER_ID = '8b000000-0000-4000-8000-000000000001';
const PERSONA_ID = '8b000000-0000-4000-8000-000000000002';
const TRACK_ID = '8b000000-0000-4000-8000-000000000003';
const AUDIO_KEY =
  'studio-audio/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.mp3';

type WhereMock = jest.Mock<
  QueryBuilderMock,
  [predicate: string, parameters?: Record<string, unknown>]
>;

interface QueryBuilderMock {
  innerJoin: jest.Mock;
  addSelect: jest.Mock;
  select: jest.Mock;
  where: WhereMock;
  andWhere: WhereMock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  groupBy: jest.Mock;
  getMany: jest.Mock;
  getOne: jest.Mock;
  getExists: jest.Mock;
  getRawMany: jest.Mock;
}

function queryBuilderMock(
  result: { many?: unknown[]; one?: unknown; exists?: boolean } = {},
): QueryBuilderMock {
  const queryBuilder = {} as QueryBuilderMock;
  for (const method of [
    'innerJoin',
    'addSelect',
    'select',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
    'groupBy',
  ] as const) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getMany = jest.fn().mockResolvedValue(result.many ?? []);
  queryBuilder.getOne = jest.fn().mockResolvedValue(result.one ?? null);
  queryBuilder.getExists = jest.fn().mockResolvedValue(result.exists ?? false);
  queryBuilder.getRawMany = jest.fn().mockResolvedValue([]);
  return queryBuilder;
}

const personaRow = {
  id: PERSONA_ID,
  handle: 'night-shift',
  displayName: 'Night Shift',
  kind: 'dj',
  avatarUrl: null,
};

const releaseRow = (
  index: number,
  status = StudioReleaseStatus.Published,
): StudioRelease =>
  ({
    id: `8c000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    subprofileId: PERSONA_ID,
    subprofile: personaRow,
    title: `Release ${index}`,
    type: StudioReleaseType.Mix,
    description: null,
    genre: null,
    coverKey: null,
    releasedOn: null,
    status,
    publishedAt:
      status === StudioReleaseStatus.Draft
        ? null
        : new Date(Date.UTC(2026, 9, 1, 0, 0, index)),
    rightsConfirmedAt: null,
    takenDownAt: null,
    takenDownById: null,
    takedownReason: null,
  }) as unknown as StudioRelease;

const andWherePredicates = (queryBuilder: QueryBuilderMock): string[] =>
  queryBuilder.andWhere.mock.calls.map(([predicate]) => predicate);

describe('StudioCatalogService', () => {
  let releases: { createQueryBuilder: jest.Mock; find: jest.Mock };
  let tracks: {
    createQueryBuilder: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let subprofiles: { createQueryBuilder: jest.Mock; findOne: jest.Mock };
  let ownership: { isPersonaMember: jest.Mock };
  let blockFilter: { excludeBlocked: jest.Mock };
  let storage: { createPresignedAudioStream: jest.Mock };
  let followers: {
    loadFollowerCountsFor: jest.Mock;
    viewerFollowingFor: jest.Mock;
  };
  let service: StudioCatalogService;

  beforeEach(() => {
    releases = {
      createQueryBuilder: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };
    tracks = {
      createQueryBuilder: jest.fn(() => queryBuilderMock()),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    subprofiles = { createQueryBuilder: jest.fn(), findOne: jest.fn() };
    ownership = { isPersonaMember: jest.fn().mockResolvedValue(false) };
    blockFilter = {
      excludeBlocked: jest.fn((queryBuilder: QueryBuilderMock) => queryBuilder),
    };
    storage = {
      createPresignedAudioStream: jest.fn().mockResolvedValue({
        url: 'https://bucket.example/stream',
        expiresAt: '2026-10-08T12:15:00.000Z',
      }),
    };
    followers = {
      loadFollowerCountsFor: jest.fn().mockResolvedValue(new Map()),
      viewerFollowingFor: jest.fn().mockResolvedValue(new Set()),
    };
    service = new StudioCatalogService(
      releases as unknown as Repository<StudioRelease>,
      tracks as unknown as Repository<StudioTrack>,
      subprofiles as unknown as Repository<Subprofile>,
      ownership as unknown as StudioOwnershipService,
      blockFilter as unknown as BlockFilterService,
      storage as unknown as StorageService,
      followers as unknown as SubprofileFollowersService,
    );
  });

  describe('listReleases', () => {
    it('pages 24 at a time and hands back a cursor at the 24th release', async () => {
      const rows = Array.from({ length: 25 }, (_unused, index) =>
        releaseRow(25 - index),
      );
      const queryBuilder = queryBuilderMock({ many: rows });
      releases.createQueryBuilder.mockReturnValue(queryBuilder);

      const page = await service.listReleases(VIEWER_ID, undefined);

      expect(queryBuilder.limit).toHaveBeenCalledWith(25);
      expect(page.items).toHaveLength(24);
      expect(page.pageInfo.hasMore).toBe(true);
      expect(page.pageInfo.nextCursor).toBe(
        encodeStudioCursor({
          publishedAt: rows[23]!.publishedAt!,
          id: rows[23]!.id,
        }),
      );
    });

    it('serves only published releases of listenable personas, minus blocked creators', async () => {
      const queryBuilder = queryBuilderMock();
      releases.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.listReleases(VIEWER_ID, undefined);

      expect(queryBuilder.where).toHaveBeenCalledWith(
        'release.status = :publishedStatus',
        { publishedStatus: 'published' },
      );
      expect(
        andWherePredicates(queryBuilder).some((predicate) =>
          predicate.includes('content_moderation'),
        ),
      ).toBe(true);
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        queryBuilder,
        VIEWER_ID,
        '"persona"."user_id"',
      );
    });

    it('seeks past a decoded cursor and reads a malformed one as the first page', async () => {
      const seeking = queryBuilderMock();
      releases.createQueryBuilder.mockReturnValueOnce(seeking);
      await service.listReleases(
        VIEWER_ID,
        encodeStudioCursor({
          publishedAt: new Date('2026-10-01T00:00:00.000Z'),
          id: '8c000000-0000-4000-8000-000000000001',
        }),
      );
      expect(andWherePredicates(seeking)).toContain(
        '("release"."published_at", "release"."id") < (:cursorPublishedAt, :cursorId)',
      );

      const firstPage = queryBuilderMock();
      releases.createQueryBuilder.mockReturnValueOnce(firstPage);
      await service.listReleases(VIEWER_ID, 'garbage');
      expect(
        andWherePredicates(firstPage).some((predicate) =>
          predicate.includes('cursorId'),
        ),
      ).toBe(false);
    });

    it('narrows the feed to one genre and leaves it whole without one', async () => {
      const narrowed = queryBuilderMock();
      releases.createQueryBuilder.mockReturnValueOnce(narrowed);
      await service.listReleases(VIEWER_ID, undefined, 'fado');
      expect(narrowed.andWhere).toHaveBeenCalledWith(
        '"release"."genre" = :studioGenre',
        { studioGenre: 'fado' },
      );

      const whole = queryBuilderMock();
      releases.createQueryBuilder.mockReturnValueOnce(whole);
      await service.listReleases(VIEWER_ID, undefined);
      expect(
        andWherePredicates(whole).some((predicate) =>
          predicate.includes('studioGenre'),
        ),
      ).toBe(false);
    });
  });

  describe('listGenres', () => {
    it('lists the genres of releases the viewer can hear, in the contract order', async () => {
      const queryBuilder = queryBuilderMock();
      queryBuilder.getRawMany.mockResolvedValue([
        { genre: 'rock' },
        { genre: 'fado' },
        { genre: 'polka' },
      ]);
      releases.createQueryBuilder.mockReturnValue(queryBuilder);

      const result = await service.listGenres(VIEWER_ID);

      expect(result).toEqual({ genres: ['fado', 'rock'] });
      expect(queryBuilder.select).toHaveBeenCalledWith(
        'DISTINCT "release"."genre"',
        'genre',
      );
      expect(andWherePredicates(queryBuilder)).toContain(
        '"release"."genre" IS NOT NULL',
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        queryBuilder,
        VIEWER_ID,
        '"persona"."user_id"',
      );
    });
  });

  describe('search', () => {
    it('folds accents on both sides and escapes LIKE wildcards', async () => {
      const queryBuilder = queryBuilderMock();
      releases.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.search(VIEWER_ID, '  São_50%  ', 'releases');

      const searchCall = queryBuilder.andWhere.mock.calls.find(([predicate]) =>
        predicate.includes('studioSearchPattern'),
      );
      expect(searchCall?.[0]).toContain('translate(lower(');
      expect(searchCall?.[0]).toContain(`ESCAPE '\\'`);
      expect(searchCall?.[1]).toEqual({ studioSearchPattern: '%São\\_50\\%%' });
    });

    it('answers empty arrays for the types not asked, without querying them', async () => {
      releases.createQueryBuilder.mockReturnValue(queryBuilderMock());
      const result = await service.search(VIEWER_ID, 'fado', 'releases');
      expect(result.tracks).toEqual([]);
      expect(result.artists).toEqual([]);
      expect(subprofiles.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('lists artists only among musician and DJ personas with a published release', async () => {
      const queryBuilder = queryBuilderMock();
      subprofiles.createQueryBuilder.mockReturnValue(queryBuilder);
      await service.search(VIEWER_ID, 'night', 'artists');
      expect(queryBuilder.where).toHaveBeenCalledWith(
        'persona.kind IN (:...artistKinds)',
        { artistKinds: ['musician', 'dj'] },
      );
      expect(
        andWherePredicates(queryBuilder).some((predicate) =>
          predicate.includes(
            '"artist_release"."status" = :artistReleaseStatus',
          ),
        ),
      ).toBe(true);
    });

    it('applies a genre to releases and tracks and leaves artists alone', async () => {
      const releaseSearch = queryBuilderMock();
      const artistSearch = queryBuilderMock();
      releases.createQueryBuilder.mockReturnValue(releaseSearch);
      subprofiles.createQueryBuilder.mockReturnValue(artistSearch);

      await service.search(VIEWER_ID, 'night', 'all', 'fado');

      const trackSearch = tracks.createQueryBuilder.mock.results[0]!
        .value as QueryBuilderMock;
      for (const queryBuilder of [releaseSearch, trackSearch]) {
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
          '"release"."genre" = :studioGenre',
          { studioGenre: 'fado' },
        );
      }
      expect(
        andWherePredicates(artistSearch).some((predicate) =>
          predicate.includes('studioGenre'),
        ),
      ).toBe(false);
    });

    it('answers empty catalog arrays for a playlist search, without querying', async () => {
      const result = await service.search(VIEWER_ID, 'night', 'playlists');
      expect(result).toEqual({ releases: [], tracks: [], artists: [] });
      expect(releases.createQueryBuilder).not.toHaveBeenCalled();
      expect(subprofiles.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('getRelease', () => {
    it('answers a listener 404 for a release that is not listenable', async () => {
      releases.createQueryBuilder
        .mockReturnValueOnce(
          queryBuilderMock({ one: releaseRow(1, StudioReleaseStatus.Draft) }),
        )
        .mockReturnValueOnce(queryBuilderMock({ exists: false }));
      await expect(
        service.getRelease(VIEWER_ID, releaseRow(1).id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets an owner read a draft without the listenable check', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1, StudioReleaseStatus.Draft) }),
      );
      const response = await service.getRelease(VIEWER_ID, releaseRow(1).id);
      expect(response.isOwner).toBe(true);
      expect(response.status).toBe('draft');
      expect(releases.createQueryBuilder).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStream', () => {
    const trackRow = (
      audioKey: string | null,
      durationSeconds: number | null = audioKey ? 200 : null,
    ) => ({
      id: TRACK_ID,
      releaseId: releaseRow(1).id,
      audioKey,
      audioContentType: audioKey ? 'audio/mpeg' : null,
      durationSeconds,
    });

    beforeEach(() => {
      tracks.findOne.mockResolvedValue(trackRow(AUDIO_KEY));
    });

    it('streams a draft to its owner with the stored type', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1, StudioReleaseStatus.Draft) }),
      );
      expect(await service.getStream(VIEWER_ID, TRACK_ID)).toEqual({
        url: 'https://bucket.example/stream',
        expiresAt: '2026-10-08T12:15:00.000Z',
      });
      expect(storage.createPresignedAudioStream).toHaveBeenCalledWith(
        AUDIO_KEY,
        'audio/mpeg',
      );
    });

    it('answers 404 to everyone, owners included, for a taken-down release', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1, StudioReleaseStatus.TakenDown) }),
      );
      await expect(
        service.getStream(VIEWER_ID, TRACK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.createPresignedAudioStream).not.toHaveBeenCalled();
    });

    it('answers a listener 404 for a draft', async () => {
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1, StudioReleaseStatus.Draft) }),
      );
      await expect(
        service.getStream(VIEWER_ID, TRACK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 404 for a track whose audio is still uploading', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      tracks.findOne.mockResolvedValue(trackRow(null));
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1, StudioReleaseStatus.Draft) }),
      );
      await expect(
        service.getStream(VIEWER_ID, TRACK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 404 for a track with an audio key and no duration yet', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      tracks.findOne.mockResolvedValue(trackRow(AUDIO_KEY, null));
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1, StudioReleaseStatus.Draft) }),
      );
      await expect(
        service.getStream(VIEWER_ID, TRACK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.createPresignedAudioStream).not.toHaveBeenCalled();
    });
  });

  describe('getArtist', () => {
    beforeEach(() => {
      subprofiles.findOne.mockResolvedValue({
        ...personaRow,
        bio: 'Sets from the river.',
      });
    });

    it('answers a listener 404 for a persona that is not listenable', async () => {
      releases.find.mockResolvedValue([releaseRow(1)]);
      subprofiles.createQueryBuilder.mockReturnValue(
        queryBuilderMock({ exists: false }),
      );
      await expect(
        service.getArtist(VIEWER_ID, PERSONA_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('shows drafts and taken-down releases to an owner only', async () => {
      releases.find
        .mockResolvedValueOnce([releaseRow(1)])
        .mockResolvedValueOnce([releaseRow(2, StudioReleaseStatus.Draft)]);
      ownership.isPersonaMember.mockResolvedValue(true);
      const ownerView = await service.getArtist(VIEWER_ID, PERSONA_ID);
      expect(ownerView.ownerReleases?.map((card) => card.status)).toEqual([
        'draft',
      ]);
      expect(ownerView.artist.city).toBeNull();

      releases.find.mockResolvedValue([releaseRow(1)]);
      ownership.isPersonaMember.mockResolvedValue(false);
      subprofiles.createQueryBuilder.mockReturnValue(
        queryBuilderMock({ exists: true }),
      );
      const listenerView = await service.getArtist(VIEWER_ID, PERSONA_ID);
      expect(listenerView.ownerReleases).toBeNull();
      expect(listenerView.releases).toHaveLength(1);
    });

    it('carries the follower total and the viewer follow state', async () => {
      releases.find.mockResolvedValue([releaseRow(1)]);
      subprofiles.createQueryBuilder.mockReturnValue(
        queryBuilderMock({ exists: true }),
      );
      followers.loadFollowerCountsFor.mockResolvedValue(
        new Map([[PERSONA_ID, 12]]),
      );
      followers.viewerFollowingFor.mockResolvedValue(new Set([PERSONA_ID]));

      const artist = await service.getArtist(VIEWER_ID, PERSONA_ID);

      expect(artist.followerCount).toBe(12);
      expect(artist.isFollowing).toBe(true);
      expect(followers.viewerFollowingFor).toHaveBeenCalledWith(VIEWER_ID, [
        PERSONA_ID,
      ]);
    });

    it('reads followers by the stored persona id when the link carries it in capitals', async () => {
      releases.find.mockResolvedValue([releaseRow(1)]);
      subprofiles.createQueryBuilder.mockReturnValue(
        queryBuilderMock({ exists: true }),
      );
      followers.loadFollowerCountsFor.mockResolvedValue(
        new Map([[PERSONA_ID, 12]]),
      );
      followers.viewerFollowingFor.mockResolvedValue(new Set([PERSONA_ID]));

      const artist = await service.getArtist(
        VIEWER_ID,
        PERSONA_ID.toUpperCase(),
      );

      expect(followers.loadFollowerCountsFor).toHaveBeenCalledWith([
        PERSONA_ID,
      ]);
      expect(followers.viewerFollowingFor).toHaveBeenCalledWith(VIEWER_ID, [
        PERSONA_ID,
      ]);
      expect(artist.followerCount).toBe(12);
      expect(artist.isFollowing).toBe(true);
    });

    it('reads a persona nobody follows as zero followers and unfollowed', async () => {
      releases.find.mockResolvedValue([releaseRow(1)]);
      subprofiles.createQueryBuilder.mockReturnValue(
        queryBuilderMock({ exists: true }),
      );

      const artist = await service.getArtist(VIEWER_ID, PERSONA_ID);

      expect(artist.followerCount).toBe(0);
      expect(artist.isFollowing).toBe(false);
    });
  });
});

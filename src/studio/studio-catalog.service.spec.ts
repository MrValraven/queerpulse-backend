import { HttpException, NotFoundException } from '@nestjs/common';
import { In, Repository } from 'typeorm';
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
import { StudioReleaseDispute } from './entities/studio-release-dispute.entity';
import {
  StudioClaimantRole,
  StudioCopyrightClaim,
  StudioCopyrightClaimStatus,
} from './entities/studio-copyright-claim.entity';
import {
  LISTENER_HEARD_TRACK_FILTER_SQL,
  LISTENER_PLAYABLE_TRACK_FILTER_SQL,
  StudioCatalogService,
} from './studio-catalog.service';
import { encodeStudioCursor } from './studio-cursor';
import { episodeReleasedSql } from './studio-episode-rule';
import { StudioOwnershipService } from './studio-ownership.service';
import { notWithheldTrackSql } from './studio-playlist-visibility';
import {
  RELEASE_CREDIT_SUMMARY_SQL,
  TRACK_PUBLIC_CREDITS_SQL,
} from './studio-persona-credit-public';
import { StudioReleaseExtrasService } from './studio-release-extras.service';
import { EMPTY_RELEASE_EXTRAS } from './studio-response';
import { listenablePersonaSql } from './studio-visibility';
import { STUDIO_ARTIST_PERSONA_KINDS } from './studio.constants';

const VIEWER_ID = '8b000000-0000-4000-8000-000000000001';
const PERSONA_ID = '8b000000-0000-4000-8000-000000000002';
const TRACK_ID = '8b000000-0000-4000-8000-000000000003';
const PUBLISHED_EPISODE_ID = '8b000000-0000-4000-8000-000000000011';
const DRAFT_EPISODE_ID = '8b000000-0000-4000-8000-000000000012';
const OTHER_DRAFT_EPISODE_ID = '8b000000-0000-4000-8000-000000000013';
const AUDIO_KEY =
  'studio-audio/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.mp3';
const PEAKS = Array.from({ length: 200 }, (_unused, index) => index);

type WhereMock = jest.Mock<
  QueryBuilderMock,
  [predicate: string, parameters?: Record<string, unknown>]
>;

interface QueryBuilderMock {
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
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
    'leftJoin',
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

const takenDownWhileDraft = (): StudioRelease => ({
  ...releaseRow(1, StudioReleaseStatus.TakenDown),
  publishedAt: null,
});

/** What a rejected promise threw, for status and body checks. */
const thrownBy = async (pending: Promise<unknown>): Promise<HttpException> => {
  try {
    await pending;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('Expected the call to throw');
};

describe('StudioCatalogService', () => {
  let releases: { createQueryBuilder: jest.Mock; find: jest.Mock };
  let tracks: {
    createQueryBuilder: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    query: jest.Mock;
    manager: { find: jest.Mock };
  };
  let subprofiles: { createQueryBuilder: jest.Mock; findOne: jest.Mock };
  let ownership: { isPersonaMember: jest.Mock };
  let blockFilter: { excludeBlocked: jest.Mock };
  let storage: { createPresignedAudioStream: jest.Mock };
  let followers: {
    loadFollowerCountsFor: jest.Mock;
    viewerFollowingFor: jest.Mock;
  };
  let disputes: { find: jest.Mock };
  let releaseExtras: {
    forRelease: jest.Mock;
    supportLinksFor: jest.Mock;
    reminderStatesFor: jest.Mock;
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
      query: jest.fn().mockResolvedValue([]),
      manager: { find: jest.fn().mockResolvedValue([]) },
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
    disputes = { find: jest.fn().mockResolvedValue([]) };
    releaseExtras = {
      forRelease: jest.fn().mockResolvedValue(EMPTY_RELEASE_EXTRAS),
      supportLinksFor: jest.fn().mockResolvedValue([]),
      reminderStatesFor: jest.fn().mockResolvedValue(new Set()),
    };
    service = new StudioCatalogService(
      releases as unknown as Repository<StudioRelease>,
      tracks as unknown as Repository<StudioTrack>,
      subprofiles as unknown as Repository<Subprofile>,
      ownership as unknown as StudioOwnershipService,
      blockFilter as unknown as BlockFilterService,
      storage as unknown as StorageService,
      followers as unknown as SubprofileFollowersService,
      disputes as unknown as Repository<StudioReleaseDispute>,
      releaseExtras as unknown as StudioReleaseExtrasService,
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
      await service.listReleases(VIEWER_ID, undefined, { genre: 'fado' });
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

    it('narrows the feed by mood and by scene, combined with the genre', async () => {
      const narrowed = queryBuilderMock();
      releases.createQueryBuilder.mockReturnValueOnce(narrowed);
      await service.listReleases(VIEWER_ID, undefined, {
        genre: 'electronic',
        mood: 'late-night',
        sceneId: 'f1000000-0000-4000-8000-000000000001',
      });
      expect(narrowed.andWhere).toHaveBeenCalledWith(
        '"release"."genre" = :studioGenre',
        { studioGenre: 'electronic' },
      );
      expect(narrowed.andWhere).toHaveBeenCalledWith(
        '"release"."mood" = :studioMood',
        { studioMood: 'late-night' },
      );
      expect(narrowed.andWhere).toHaveBeenCalledWith(
        '"release"."scene_id" = :studioSceneId',
        { studioSceneId: 'f1000000-0000-4000-8000-000000000001' },
      );
    });

    it('loads each card with its scene', async () => {
      const queryBuilder = queryBuilderMock();
      releases.createQueryBuilder.mockReturnValueOnce(queryBuilder);
      await service.listReleases(VIEWER_ID, undefined);
      expect(queryBuilder.leftJoin).toHaveBeenCalledWith(
        'release.scene',
        'scene',
      );
      expect(queryBuilder.addSelect).toHaveBeenCalledWith([
        'scene.id',
        'scene.slug',
        'scene.name',
        'scene.status',
      ]);
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

  describe('listMoods', () => {
    it('lists the moods of releases the viewer can hear, in the contract order', async () => {
      const queryBuilder = queryBuilderMock();
      queryBuilder.getRawMany.mockResolvedValue([
        { mood: 'tender' },
        { mood: 'late-night' },
        { mood: 'gloomy' },
      ]);
      releases.createQueryBuilder.mockReturnValue(queryBuilder);

      const result = await service.listMoods(VIEWER_ID);

      expect(result).toEqual({ moods: ['late-night', 'tender'] });
      expect(queryBuilder.select).toHaveBeenCalledWith(
        'DISTINCT "release"."mood"',
        'mood',
      );
      expect(andWherePredicates(queryBuilder)).toContain(
        '"release"."mood" IS NOT NULL',
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

    it('lists artists only among personas of the Studio artist kinds with a published release', async () => {
      const queryBuilder = queryBuilderMock();
      subprofiles.createQueryBuilder.mockReturnValue(queryBuilder);
      await service.search(VIEWER_ID, 'night', 'artists');
      expect(queryBuilder.where).toHaveBeenCalledWith(
        'persona.kind IN (:...artistKinds)',
        { artistKinds: [...STUDIO_ARTIST_PERSONA_KINDS] },
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

      await service.search(VIEWER_ID, 'night', 'all', { genre: 'fado' });

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

    it('applies a mood to releases and tracks and leaves artists alone', async () => {
      const releaseSearch = queryBuilderMock();
      const artistSearch = queryBuilderMock();
      releases.createQueryBuilder.mockReturnValue(releaseSearch);
      subprofiles.createQueryBuilder.mockReturnValue(artistSearch);

      await service.search(VIEWER_ID, 'night', 'all', { mood: 'tender' });

      const trackSearch = tracks.createQueryBuilder.mock.results[0]!
        .value as QueryBuilderMock;
      for (const queryBuilder of [releaseSearch, trackSearch]) {
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
          '"release"."mood" = :studioMood',
          { studioMood: 'tender' },
        );
      }
      expect(
        andWherePredicates(artistSearch).some((predicate) =>
          predicate.includes('studioMood'),
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

    // The disputes, credit summary and extras reads answer empty through
    // the shared mocks, the way the neighbouring getRelease tests run.
    it('gives the owner the measuring state on every track row', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1, StudioReleaseStatus.Published) }),
      );
      tracks.find.mockResolvedValue([
        {
          id: TRACK_ID,
          releaseId: releaseRow(1).id,
          position: 1,
          title: 'Opening',
          audioKey: AUDIO_KEY,
          audioContentType: 'audio/mpeg',
          durationSeconds: 200,
          isExplicit: false,
          waveformPeaks: null,
          loudnessLufs: null,
          peakDb: null,
          syncedLyrics: [{ ms: 0, text: 'First line' }],
          chapters: null,
        },
      ]);
      const response = await service.getRelease(VIEWER_ID, releaseRow(1).id);
      expect(response.tracks[0]).toEqual(
        expect.objectContaining({
          hasAnalysis: false,
          loudnessLufs: null,
          peakDb: null,
          syncedLyrics: [{ ms: 0, text: 'First line' }],
          chapters: null,
        }),
      );
    });

    // Studio open demo pages: the withdrawn view.
    it('answers a listener 410 with nothing but the code for a release taken down while live', async () => {
      releases.createQueryBuilder
        .mockReturnValueOnce(
          queryBuilderMock({
            one: releaseRow(1, StudioReleaseStatus.TakenDown),
          }),
        )
        .mockReturnValueOnce(queryBuilderMock({ exists: false }));
      const personaCheck = queryBuilderMock({ exists: true });
      subprofiles.createQueryBuilder.mockReturnValueOnce(personaCheck);

      const failure = await thrownBy(
        service.getRelease(VIEWER_ID, releaseRow(1).id),
      );

      expect(failure).toBeInstanceOf(HttpException);
      expect(failure.getStatus()).toBe(410);
      expect(failure.getResponse()).toEqual({
        statusCode: 410,
        code: 'studio_release_withdrawn',
        message: 'This release was withdrawn.',
      });
      expect(JSON.stringify(failure.getResponse())).not.toContain('Release 1');
      expect(personaCheck.where).toHaveBeenCalledWith(
        'persona.id = :subprofileId',
        { subprofileId: PERSONA_ID },
      );
      expect(personaCheck.andWhere).toHaveBeenCalledWith(
        listenablePersonaSql('persona'),
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        personaCheck,
        VIEWER_ID,
        '"persona"."user_id"',
      );
    });

    it('keeps the plain 404 when the persona is unlisted, taken down or blocked either way', async () => {
      releases.createQueryBuilder
        .mockReturnValueOnce(
          queryBuilderMock({
            one: releaseRow(1, StudioReleaseStatus.TakenDown),
          }),
        )
        .mockReturnValueOnce(queryBuilderMock({ exists: false }));
      subprofiles.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ exists: false }),
      );

      await expect(
        service.getRelease(VIEWER_ID, releaseRow(1).id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('keeps the plain 404 for a release taken down while still a draft, without asking about the persona', async () => {
      releases.createQueryBuilder
        .mockReturnValueOnce(queryBuilderMock({ one: takenDownWhileDraft() }))
        .mockReturnValueOnce(queryBuilderMock({ exists: false }));

      await expect(
        service.getRelease(VIEWER_ID, releaseRow(1).id),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(subprofiles.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('keeps the plain 404 for a draft and asks nothing about the persona', async () => {
      releases.createQueryBuilder
        .mockReturnValueOnce(
          queryBuilderMock({ one: releaseRow(1, StudioReleaseStatus.Draft) }),
        )
        .mockReturnValueOnce(queryBuilderMock({ exists: false }));

      await expect(
        service.getRelease(VIEWER_ID, releaseRow(1).id),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(subprofiles.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('gives the owner of a taken-down release the 200 with the reason, the latest dispute and canDispute', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({
          one: {
            ...releaseRow(1, StudioReleaseStatus.TakenDown),
            takedownReason: 'Uploaded without the rights',
          },
        }),
      );
      disputes.find.mockResolvedValue([
        {
          id: 'dispute-1',
          releaseId: releaseRow(1).id,
          note: 'I hold the rights',
          status: 'rejected',
          staffReply: 'The label wrote to us',
          decidedById: null,
          createdAt: new Date('2026-10-11T09:00:00.000Z'),
          decidedAt: new Date('2026-10-12T09:00:00.000Z'),
        },
      ]);

      const response = await service.getRelease(VIEWER_ID, releaseRow(1).id);

      expect(response.status).toBe('taken_down');
      expect(response.takedownReason).toBe('Uploaded without the rights');
      expect(response.dispute?.staffReply).toBe('The label wrote to us');
      expect(response.canDispute).toBe(true);
      expect(disputes.find).toHaveBeenCalledWith({
        where: { releaseId: releaseRow(1).id },
        order: { createdAt: 'DESC', id: 'DESC' },
        take: 3,
      });
      expect(subprofiles.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('reads no disputes for a listener of a live release', async () => {
      releases.createQueryBuilder
        .mockReturnValueOnce(queryBuilderMock({ one: releaseRow(1) }))
        .mockReturnValueOnce(queryBuilderMock({ exists: true }));

      const response = await service.getRelease(VIEWER_ID, releaseRow(1).id);

      expect(response.dispute).toBeNull();
      expect(response.canDispute).toBe(false);
      expect(disputes.find).not.toHaveBeenCalled();
    });

    it('reads a scheduled release for a granted listener through the visible statuses', async () => {
      const visibility = queryBuilderMock({ exists: true });
      releases.createQueryBuilder
        .mockReturnValueOnce(
          queryBuilderMock({
            one: releaseRow(1, StudioReleaseStatus.Scheduled),
          }),
        )
        .mockReturnValueOnce(visibility);
      tracks.find.mockResolvedValue([
        {
          id: TRACK_ID,
          position: 1,
          title: 'Opening',
          audioKey: AUDIO_KEY,
          durationSeconds: 200,
          isExplicit: false,
        },
      ]);

      const response = await service.getRelease(VIEWER_ID, releaseRow(1).id);

      expect(visibility.where).toHaveBeenCalledWith(
        'release.status IN (:...visibleStatuses)',
        { visibleStatuses: ['published', 'scheduled'] },
      );
      expect(andWherePredicates(visibility)).toContain(
        listenablePersonaSql('persona'),
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        visibility,
        VIEWER_ID,
        '"persona"."user_id"',
      );
      expect(response.tracks).toEqual([]);
      expect(response.trackCount).toBe(1);
      expect(releaseExtras.forRelease).toHaveBeenCalledWith(
        VIEWER_ID,
        expect.objectContaining({ id: releaseRow(1).id }),
      );
    });

    it('carries the extras into the response', async () => {
      releases.createQueryBuilder
        .mockReturnValueOnce(queryBuilderMock({ one: releaseRow(1) }))
        .mockReturnValueOnce(queryBuilderMock({ exists: true }));
      releaseExtras.forRelease.mockResolvedValue({
        supportLinks: [{ platform: 'bandcamp', urlOrHandle: 'nightshift' }],
        versions: [
          {
            version: 2,
            note: 'Added a bonus track',
            createdAt: new Date('2026-10-10T09:00:00.000Z'),
          },
        ],
        isReminderSet: false,
      });

      const response = await service.getRelease(VIEWER_ID, releaseRow(1).id);

      expect(response.supportLinks).toEqual([
        { platform: 'bandcamp', urlOrHandle: 'nightshift' },
      ]);
      expect(response.version).toBe(2);
      expect(response.versions).toEqual([
        {
          version: 2,
          note: 'Added a bonus track',
          createdAt: '2026-10-10T09:00:00.000Z',
        },
      ]);
    });

    it('serves a preview with every track that has audio and the preview flag', async () => {
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1, StudioReleaseStatus.Draft) }),
      );
      tracks.find.mockResolvedValue([
        {
          id: TRACK_ID,
          position: 2,
          title: 'Opening',
          audioKey: AUDIO_KEY,
          durationSeconds: 200,
          isExplicit: false,
        },
      ]);

      const response = await service.getReleaseAsPreview(
        VIEWER_ID,
        releaseRow(1).id,
      );

      expect(response.isPreview).toBe(true);
      expect(response.isOwner).toBe(false);
      expect(response.tracks.map((summary) => summary.position)).toEqual([1]);
      // No listenable check: the token already admitted the caller.
      expect(releases.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(disputes.find).not.toHaveBeenCalled();
    });

    it('gives an owner their own preview with every track and the owner fields', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1, StudioReleaseStatus.Draft) }),
      );
      tracks.find.mockResolvedValue([
        {
          id: TRACK_ID,
          position: 1,
          title: 'Opening',
          audioKey: null,
          durationSeconds: null,
          isExplicit: false,
        },
      ]);

      const response = await service.getReleaseAsPreview(
        VIEWER_ID,
        releaseRow(1).id,
      );

      expect(response.isPreview).toBe(true);
      expect(response.isOwner).toBe(true);
      expect(response.tracks).toHaveLength(1);
    });

    it('answers a preview of a missing release with a plain 404', async () => {
      releases.createQueryBuilder.mockReturnValueOnce(queryBuilderMock());
      await expect(
        service.getReleaseAsPreview(VIEWER_ID, releaseRow(1).id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('serves staff the preview link view of a draft with no owner fields', async () => {
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1, StudioReleaseStatus.Draft) }),
      );
      tracks.find.mockResolvedValue([
        {
          id: TRACK_ID,
          position: 2,
          title: 'Opening',
          audioKey: AUDIO_KEY,
          durationSeconds: 200,
          isExplicit: false,
        },
      ]);

      const response = await service.getReleaseAsStaffDraftPreview(
        releaseRow(1).id,
      );

      expect(response).toEqual(
        expect.objectContaining({
          isPreview: true,
          isOwner: false,
          rightsConfirmedAt: null,
          takedownReason: null,
          previewToken: null,
          sceneId: null,
          claims: [],
          dispute: null,
        }),
      );
      expect(response.tracks.map((summary) => summary.position)).toEqual([1]);
      expect(releaseExtras.forRelease).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ id: releaseRow(1).id }),
      );
      expect(ownership.isPersonaMember).not.toHaveBeenCalled();
      expect(disputes.find).not.toHaveBeenCalled();
    });

    it('answers a staff preview of a missing release with a plain 404', async () => {
      releases.createQueryBuilder.mockReturnValueOnce(queryBuilderMock());
      await expect(
        service.getReleaseAsStaffDraftPreview(releaseRow(1).id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('puts the draft episode into the show preview as a draft, beside the published episodes only', async () => {
      const show = {
        ...releaseRow(1, StudioReleaseStatus.Published),
        type: StudioReleaseType.Podcast,
      };
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: show }),
      );
      tracks.find.mockResolvedValue([
        {
          id: PUBLISHED_EPISODE_ID,
          position: 1,
          title: 'Pilot',
          audioKey: AUDIO_KEY,
          durationSeconds: 1800,
          isExplicit: false,
          publishedAt: new Date('2026-09-01T00:00:00Z'),
        },
        {
          id: DRAFT_EPISODE_ID,
          position: 2,
          title: 'Part two',
          audioKey: null,
          durationSeconds: null,
          isExplicit: false,
          publishedAt: null,
        },
        {
          id: OTHER_DRAFT_EPISODE_ID,
          position: 3,
          title: 'Later',
          audioKey: AUDIO_KEY,
          durationSeconds: 900,
          isExplicit: false,
          publishedAt: null,
        },
      ]);

      const response = await service.getReleaseAsStaffDraftPreview(
        show.id,
        DRAFT_EPISODE_ID,
      );

      expect(
        response.tracks.map((summary) => [summary.id, summary.isDraft]),
      ).toEqual([
        [PUBLISHED_EPISODE_ID, false],
        [DRAFT_EPISODE_ID, true],
      ]);
      expect(response.tracks[1]).toEqual(
        expect.objectContaining({
          title: 'Part two',
          hasAudio: false,
          publishedAt: null,
        }),
      );
    });

    it('answers 404 for an episode id that is no draft episode of that show', async () => {
      const show = {
        ...releaseRow(1, StudioReleaseStatus.Published),
        type: StudioReleaseType.Podcast,
      };
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: show }),
      );
      tracks.find.mockResolvedValue([
        {
          id: PUBLISHED_EPISODE_ID,
          position: 1,
          title: 'Pilot',
          audioKey: AUDIO_KEY,
          durationSeconds: 1800,
          isExplicit: false,
          publishedAt: new Date('2026-09-01T00:00:00Z'),
        },
      ]);
      await expect(
        service.getReleaseAsStaffDraftPreview(show.id, PUBLISHED_EPISODE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reads the staff extras with no viewer', async () => {
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1) }),
      );
      await service.getReleaseForStaff(releaseRow(1).id);
      expect(releaseExtras.forRelease).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ id: releaseRow(1).id }),
      );
    });
  });

  describe('getTrack', () => {
    beforeEach(() => {
      tracks.findOne.mockResolvedValue({
        id: TRACK_ID,
        releaseId: releaseRow(1).id,
      });
    });

    it('answers a listener the same 410 for a track of a withdrawn release', async () => {
      releases.createQueryBuilder
        .mockReturnValueOnce(
          queryBuilderMock({
            one: releaseRow(1, StudioReleaseStatus.TakenDown),
          }),
        )
        .mockReturnValueOnce(queryBuilderMock({ exists: false }));
      subprofiles.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ exists: true }),
      );

      const failure = await thrownBy(service.getTrack(VIEWER_ID, TRACK_ID));

      expect(failure.getStatus()).toBe(410);
      expect(failure.getResponse()).toEqual(
        expect.objectContaining({ code: 'studio_release_withdrawn' }),
      );
    });

    it('keeps the plain 404 for a track of a release taken down while still a draft', async () => {
      releases.createQueryBuilder
        .mockReturnValueOnce(queryBuilderMock({ one: takenDownWhileDraft() }))
        .mockReturnValueOnce(queryBuilderMock({ exists: false }));

      await expect(
        service.getTrack(VIEWER_ID, TRACK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('staffSummariesByReleaseId', () => {
    it('asks nothing for no ids', async () => {
      expect((await service.staffSummariesByReleaseId([])).size).toBe(0);
      expect(releases.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('summarises releases in any status, with their takedown facts and no listener gate', async () => {
      const takenDown = {
        ...releaseRow(2, StudioReleaseStatus.TakenDown),
        takedownReason: 'Uploaded twice',
        takenDownAt: new Date('2026-10-12T08:00:00.000Z'),
      } as StudioRelease;
      const queryBuilder = queryBuilderMock({ many: [takenDown] });
      releases.createQueryBuilder.mockReturnValue(queryBuilder);

      const summaries = await service.staffSummariesByReleaseId([takenDown.id]);

      expect(queryBuilder.where).toHaveBeenCalledWith(
        'release.id IN (:...releaseIds)',
        { releaseIds: [takenDown.id] },
      );
      expect(andWherePredicates(queryBuilder)).toEqual([]);
      expect(blockFilter.excludeBlocked).not.toHaveBeenCalled();
      expect(summaries.get(takenDown.id)).toEqual(
        expect.objectContaining({
          title: 'Release 2',
          status: 'taken_down',
          takedownReason: 'Uploaded twice',
          takenDownAt: '2026-10-12T08:00:00.000Z',
        }),
      );
    });

    it('carries the release scene the way a card does', async () => {
      const withScene = {
        ...releaseRow(3, StudioReleaseStatus.Published),
        scene: { slug: 'lisbon-club', name: 'Lisbon club', status: 'active' },
      } as unknown as StudioRelease;
      const queryBuilder = queryBuilderMock({ many: [withScene] });
      releases.createQueryBuilder.mockReturnValue(queryBuilder);

      const summaries = await service.staffSummariesByReleaseId([withScene.id]);

      expect(queryBuilder.leftJoin).toHaveBeenCalledWith(
        'release.scene',
        'scene',
      );
      expect(summaries.get(withScene.id)?.scene).toEqual({
        slug: 'lisbon-club',
        name: 'Lisbon club',
      });
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
      waveformPeaks: null,
      loudnessLufs: null,
      peakDb: null,
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
        waveformPeaks: null,
        loudnessLufs: null,
        peakDb: null,
      });
      expect(storage.createPresignedAudioStream).toHaveBeenCalledWith(
        AUDIO_KEY,
        'audio/mpeg',
        200,
      );
    });

    it('serves the stored measurements with the stream and signs for the track length', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      tracks.findOne.mockResolvedValue({
        ...trackRow(AUDIO_KEY, 3600),
        waveformPeaks: PEAKS,
        loudnessLufs: -7.8,
        peakDb: -0.1,
      });
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1, StudioReleaseStatus.Draft) }),
      );
      expect(await service.getStream(VIEWER_ID, TRACK_ID)).toEqual(
        expect.objectContaining({
          waveformPeaks: PEAKS,
          loudnessLufs: -7.8,
          peakDb: -0.1,
        }),
      );
      expect(storage.createPresignedAudioStream).toHaveBeenCalledWith(
        AUDIO_KEY,
        'audio/mpeg',
        3600,
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

    it('streams nothing from a scheduled release to a listener', async () => {
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({
          one: releaseRow(1, StudioReleaseStatus.Scheduled),
        }),
      );
      await expect(
        service.getStream(VIEWER_ID, TRACK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.createPresignedAudioStream).not.toHaveBeenCalled();
    });

    it('streams a scheduled release to its owner', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({
          one: releaseRow(1, StudioReleaseStatus.Scheduled),
        }),
      );
      await service.getStream(VIEWER_ID, TRACK_ID);
      expect(storage.createPresignedAudioStream).toHaveBeenCalledTimes(1);
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

    it('loads the scene of every release on the artist page', async () => {
      releases.find.mockResolvedValue([]);
      ownership.isPersonaMember.mockResolvedValue(true);
      await service.getArtist(VIEWER_ID, PERSONA_ID);
      for (const [options] of releases.find.mock.calls as [
        { relations?: unknown },
      ][]) {
        expect(options.relations).toEqual({ scene: true });
      }
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

    it('lists scheduled releases soonest first with the viewer reminder, and the support links', async () => {
      const scheduled = {
        ...releaseRow(3, StudioReleaseStatus.Scheduled),
        publishedAt: null,
        publishAt: new Date('2026-10-20T18:00:00.000Z'),
      } as unknown as StudioRelease;
      releases.find
        .mockResolvedValueOnce([releaseRow(1)])
        .mockResolvedValueOnce([scheduled]);
      subprofiles.createQueryBuilder.mockReturnValue(
        queryBuilderMock({ exists: true }),
      );
      releaseExtras.supportLinksFor.mockResolvedValue([
        { platform: 'bandcamp', urlOrHandle: 'nightshift' },
      ]);
      releaseExtras.reminderStatesFor.mockResolvedValue(
        new Set([scheduled.id]),
      );

      const artist = await service.getArtist(VIEWER_ID, PERSONA_ID);

      expect(releases.find.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          where: { subprofileId: PERSONA_ID, status: 'scheduled' },
          relations: { scene: true },
          order: { publishAt: 'ASC', id: 'ASC' },
          take: 6,
        }),
      );
      expect(releaseExtras.reminderStatesFor).toHaveBeenCalledWith(VIEWER_ID, [
        scheduled.id,
      ]);
      expect(artist.upcoming).toEqual([
        expect.objectContaining({
          id: scheduled.id,
          publishAt: '2026-10-20T18:00:00.000Z',
          isReminderSet: true,
        }),
      ]);
      expect(artist.releases.map((card) => card.id)).toEqual([
        releaseRow(1).id,
      ]);
      expect(artist.supportLinks).toEqual([
        { platform: 'bandcamp', urlOrHandle: 'nightshift' },
      ]);
      expect(releaseExtras.supportLinksFor).toHaveBeenCalledWith(PERSONA_ID);
    });

    it('shows an owner scheduled releases among the owner rows', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      releases.find.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          ...releaseRow(4, StudioReleaseStatus.Scheduled),
          publishedAt: null,
          publishAt: new Date('2026-10-21T18:00:00.000Z'),
        },
      ]);

      const artist = await service.getArtist(VIEWER_ID, PERSONA_ID);

      expect(releases.find.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          where: {
            subprofileId: PERSONA_ID,
            status: In([
              StudioReleaseStatus.Draft,
              StudioReleaseStatus.Scheduled,
              StudioReleaseStatus.TakenDown,
            ]),
          },
          relations: { scene: true },
        }),
      );
      expect(artist.ownerReleases?.[0]?.status).toBe('scheduled');
      expect(artist.ownerReleases?.[0]?.publishAt).toBe(
        '2026-10-21T18:00:00.000Z',
      );
    });

    it('counts every track on owner rows and playable tracks on listener cards', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      releases.find
        .mockResolvedValueOnce([releaseRow(1)])
        .mockResolvedValueOnce([releaseRow(2, StudioReleaseStatus.Draft)]);
      const stats = queryBuilderMock();
      stats.getRawMany.mockResolvedValue([
        {
          release_id: releaseRow(1).id,
          track_count: 3,
          playable_track_count: 2,
          total_duration_seconds: 400,
          playable_duration_seconds: 400,
        },
        {
          release_id: releaseRow(2).id,
          track_count: 4,
          playable_track_count: 1,
          total_duration_seconds: 180,
          playable_duration_seconds: 180,
        },
      ]);
      tracks.createQueryBuilder.mockReturnValue(stats);

      const artist = await service.getArtist(VIEWER_ID, PERSONA_ID);

      expect(artist.releases[0]?.trackCount).toBe(2);
      expect(artist.ownerReleases?.[0]?.trackCount).toBe(4);
    });
  });

  describe('persona credits', () => {
    const creditRow = {
      role: 'producer',
      persona_id: 'persona-credited',
      persona_handle: 'river-ink',
      persona_display_name: 'River Ink',
      persona_kind: 'musician',
      persona_avatar_url: null,
    };

    it('adds the accepted public credits to a track, with the viewer bound for the block filter', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      tracks.findOne.mockResolvedValue({
        id: TRACK_ID,
        releaseId: releaseRow(1).id,
        position: 1,
        title: 'Opening',
        audioKey: null,
        durationSeconds: null,
        isExplicit: false,
        credits: [],
        lyrics: null,
      });
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1) }),
      );
      tracks.query.mockResolvedValue([creditRow]);

      const track = await service.getTrack(VIEWER_ID, TRACK_ID);

      expect(tracks.query).toHaveBeenCalledWith(TRACK_PUBLIC_CREDITS_SQL, [
        VIEWER_ID,
        TRACK_ID,
      ]);
      expect(track.personaCredits).toEqual([
        {
          role: 'producer',
          persona: {
            id: 'persona-credited',
            handle: 'river-ink',
            name: 'River Ink',
            kind: 'musician',
            avatarUrl: null,
            isListenable: true,
          },
        },
      ]);
      expect(track.credits).toEqual([]);
    });

    // The owner path also reads the release's disputes (open demo pages),
    // so the credits ride beside them.
    it("adds the credit summary to an owner's release beside the disputes", async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1) }),
      );
      disputes.find.mockResolvedValue([]);
      tracks.query.mockResolvedValue([creditRow]);

      const release = await service.getRelease(VIEWER_ID, releaseRow(1).id);

      expect(disputes.find).toHaveBeenCalledWith({
        where: { releaseId: releaseRow(1).id },
        order: { createdAt: 'DESC', id: 'DESC' },
        take: 3,
      });
      expect(release.dispute).toBeNull();
      expect(tracks.query).toHaveBeenCalledWith(RELEASE_CREDIT_SUMMARY_SQL, [
        VIEWER_ID,
        releaseRow(1).id,
      ]);
      expect(release.personaCredits.map((row) => row.roles)).toEqual([
        ['producer'],
      ]);
    });

    it('adds the credit summary to a release for a listener, with no dispute read', async () => {
      releases.createQueryBuilder
        .mockReturnValueOnce(queryBuilderMock({ one: releaseRow(1) }))
        .mockReturnValueOnce(queryBuilderMock({ exists: true }));
      tracks.query.mockResolvedValue([creditRow]);

      const release = await service.getRelease(VIEWER_ID, releaseRow(1).id);

      expect(disputes.find).not.toHaveBeenCalled();
      expect(release.personaCredits.map((row) => row.persona.id)).toEqual([
        'persona-credited',
      ]);
    });

    it('reads the summary for staff with no viewer, so blocks are left aside', async () => {
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1) }),
      );
      await service.getReleaseForStaff(releaseRow(1).id);
      expect(tracks.query).toHaveBeenCalledWith(RELEASE_CREDIT_SUMMARY_SQL, [
        null,
        releaseRow(1).id,
      ]);
    });
  });

  // Studio v3: a track still uploading stays out of every listener read.
  describe('tracks still uploading', () => {
    it('answers a listener 404 for a track with no audio on a published release', async () => {
      tracks.findOne.mockResolvedValue({
        id: TRACK_ID,
        releaseId: releaseRow(1).id,
        position: 2,
        audioKey: null,
        durationSeconds: null,
      });
      releases.createQueryBuilder
        .mockReturnValueOnce(queryBuilderMock({ one: releaseRow(1) }))
        .mockReturnValueOnce(queryBuilderMock({ exists: true }));
      await expect(
        service.getTrack(VIEWER_ID, TRACK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('searches tracks with confirmed audio only', async () => {
      const trackSearch = queryBuilderMock();
      tracks.createQueryBuilder.mockReturnValueOnce(trackSearch);
      releases.createQueryBuilder.mockReturnValue(queryBuilderMock());
      subprofiles.createQueryBuilder.mockReturnValue(queryBuilderMock());

      await service.search(VIEWER_ID, 'noite', 'tracks');

      expect(andWherePredicates(trackSearch)).toEqual(
        expect.arrayContaining([
          '"track"."audio_key" IS NOT NULL',
          '"track"."duration_seconds" IS NOT NULL',
        ]),
      );
    });

    it('counts playable tracks on listener cards', async () => {
      const stats = queryBuilderMock();
      stats.getRawMany.mockResolvedValue([
        {
          release_id: releaseRow(1).id,
          track_count: 3,
          playable_track_count: 2,
          total_duration_seconds: 400,
          playable_duration_seconds: 400,
        },
      ]);
      tracks.createQueryBuilder.mockReturnValue(stats);
      releases.createQueryBuilder.mockReturnValue(
        queryBuilderMock({ many: [releaseRow(1)] }),
      );

      const page = await service.listReleases(VIEWER_ID, undefined);

      expect(page.items[0]?.trackCount).toBe(2);
      expect(page.items[0]?.totalDurationSeconds).toBe(400);
      expect(stats.addSelect).toHaveBeenCalledWith(
        `COUNT(*) FILTER (WHERE ${LISTENER_PLAYABLE_TRACK_FILTER_SQL})::int`,
        'playable_track_count',
      );
    });
  });

  // Studio artist kinds.
  describe('artist kinds', () => {
    const showRow = (index: number): StudioRelease => ({
      ...releaseRow(index),
      type: StudioReleaseType.Podcast,
    });
    const episodeRow = (overrides: Record<string, unknown> = {}) => ({
      id: TRACK_ID,
      releaseId: showRow(1).id,
      position: 4,
      title: 'Housing in Lisbon',
      audioKey: AUDIO_KEY,
      audioContentType: 'audio/mpeg',
      durationSeconds: 1800,
      publishedAt: null,
      credits: [],
      lyrics: null,
      isExplicit: false,
      notes: '00:00 Intro',
      sources: [],
      waveformPeaks: null,
      loudnessLufs: null,
      peakDb: null,
      ...overrides,
    });

    it('lists the formats with a release the viewer can hear, in map order', async () => {
      const formats = queryBuilderMock();
      formats.getRawMany.mockResolvedValue([
        { kind: 'drag' },
        { kind: 'podcaster' },
        { kind: 'dj' },
        { kind: 'writer' },
      ]);
      releases.createQueryBuilder.mockReturnValue(formats);

      expect(await service.listFormats(VIEWER_ID)).toEqual({
        formats: ['music', 'podcast', 'performance'],
      });
      expect(formats.select).toHaveBeenCalledWith(
        'DISTINCT "persona"."kind"::text',
        'kind',
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        formats,
        VIEWER_ID,
        '"persona"."user_id"',
      );
    });

    it('narrows the feed to the persona kinds of a format', async () => {
      const feed = queryBuilderMock({ many: [] });
      releases.createQueryBuilder.mockReturnValue(feed);

      await service.listReleases(VIEWER_ID, undefined, { format: 'podcast' });

      expect(feed.andWhere).toHaveBeenCalledWith(
        '"persona"."kind" IN (:...studioFormatKinds)',
        { studioFormatKinds: ['podcaster', 'podcast_producer'] },
      );
    });

    it('narrows search artists to a format and puts the format on each row', async () => {
      const artistSearch = queryBuilderMock({
        many: [{ ...personaRow, kind: 'poet' }],
      });
      subprofiles.createQueryBuilder.mockReturnValue(artistSearch);

      const result = await service.search(VIEWER_ID, 'salt', 'artists', {
        format: 'spoken_word',
      });

      expect(artistSearch.where).toHaveBeenCalledWith(
        'persona.kind IN (:...artistKinds)',
        { artistKinds: ['poet', 'spoken_word'] },
      );
      expect(result.artists[0]?.format).toBe('spoken_word');
    });

    it('searches published episodes only', async () => {
      const trackSearch = queryBuilderMock();
      tracks.createQueryBuilder.mockReturnValueOnce(trackSearch);
      releases.createQueryBuilder.mockReturnValue(queryBuilderMock());
      subprofiles.createQueryBuilder.mockReturnValue(queryBuilderMock());

      await service.search(VIEWER_ID, 'housing', 'tracks');

      expect(andWherePredicates(trackSearch)).toContain(
        episodeReleasedSql('track', 'release'),
      );
    });

    it('answers a listener 404 for a draft episode page', async () => {
      tracks.findOne.mockResolvedValue(episodeRow());
      releases.createQueryBuilder
        .mockReturnValueOnce(queryBuilderMock({ one: showRow(1) }))
        .mockReturnValueOnce(queryBuilderMock({ exists: true }));

      await expect(
        service.getTrack(VIEWER_ID, TRACK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('shows the owner a draft episode with its notes, marked as a draft', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      tracks.findOne.mockResolvedValue(episodeRow());
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: showRow(1) }),
      );

      const response = await service.getTrack(VIEWER_ID, TRACK_ID);

      expect(response.isDraft).toBe(true);
      expect(response.notes).toBe('00:00 Intro');
      expect(response.release.format).toBe('music');
    });

    it('streams nothing from a draft episode to a listener', async () => {
      tracks.findOne.mockResolvedValue(episodeRow());
      releases.createQueryBuilder
        .mockReturnValueOnce(queryBuilderMock({ one: showRow(1) }))
        .mockReturnValueOnce(queryBuilderMock({ exists: true }));

      await expect(
        service.getStream(VIEWER_ID, TRACK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.createPresignedAudioStream).not.toHaveBeenCalled();
    });

    it('streams a draft episode to its owner', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      tracks.findOne.mockResolvedValue(episodeRow());
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: showRow(1) }),
      );

      await service.getStream(VIEWER_ID, TRACK_ID);

      expect(storage.createPresignedAudioStream).toHaveBeenCalledWith(
        AUDIO_KEY,
        'audio/mpeg',
        1800,
      );
    });

    it('streams a published episode to a listener', async () => {
      tracks.findOne.mockResolvedValue(
        episodeRow({ publishedAt: new Date('2026-10-01T09:00:00.000Z') }),
      );
      releases.createQueryBuilder
        .mockReturnValueOnce(queryBuilderMock({ one: showRow(1) }))
        .mockReturnValueOnce(queryBuilderMock({ exists: true }));

      await service.getStream(VIEWER_ID, TRACK_ID);

      expect(storage.createPresignedAudioStream).toHaveBeenCalled();
    });

    it('counts published episodes only on listener cards', async () => {
      const stats = queryBuilderMock();
      stats.getRawMany.mockResolvedValue([
        {
          release_id: showRow(1).id,
          track_count: 4,
          playable_track_count: 3,
          total_duration_seconds: 7200,
          playable_duration_seconds: 5400,
        },
      ]);
      tracks.createQueryBuilder.mockReturnValue(stats);
      releases.createQueryBuilder.mockReturnValue(
        queryBuilderMock({ many: [showRow(1)] }),
      );

      const page = await service.listReleases(VIEWER_ID, undefined);

      expect(page.items[0]?.trackCount).toBe(3);
      expect(page.items[0]?.totalDurationSeconds).toBe(5400);
      expect(stats.innerJoin).toHaveBeenCalledWith('track.release', 'release');
      expect(LISTENER_PLAYABLE_TRACK_FILTER_SQL).toContain(
        episodeReleasedSql('track', 'release'),
      );
      expect(stats.addSelect).toHaveBeenCalledWith(
        `COALESCE(SUM("track"."duration_seconds") FILTER (WHERE ${LISTENER_HEARD_TRACK_FILTER_SQL}), 0)::int`,
        'playable_duration_seconds',
      );
    });
  });

  // Studio safety and moderation: withheld tracks and the owner's claims.
  describe('Studio safety', () => {
    const WITHHELD_AT = new Date('2026-10-14T10:00:00.000Z');
    const withheldTrack = {
      id: TRACK_ID,
      releaseId: releaseRow(1).id,
      position: 1,
      title: 'Borrowed',
      audioKey: AUDIO_KEY,
      audioContentType: 'audio/mpeg',
      durationSeconds: 200,
      isExplicit: false,
      credits: [],
      lyrics: null,
      waveformPeaks: null,
      loudnessLufs: null,
      peakDb: null,
      withheldAt: WITHHELD_AT,
    };
    const acceptedClaim = {
      id: 'cb000000-0000-4000-8000-000000000001',
      trackId: TRACK_ID,
      releaseId: releaseRow(1).id,
      claimantId: 'cb100000-0000-4000-8000-000000000001',
      claimantRole: StudioClaimantRole.RightsHolder,
      originalWork: 'Saudade',
      originalLink: null,
      details: 'The hook',
      status: StudioCopyrightClaimStatus.Accepted,
      counterNote: null,
      counteredAt: null,
      claimantReply: null,
      repliedAt: null,
      staffNote: null,
      acceptedAt: WITHHELD_AT,
      decidedAt: null,
      createdAt: new Date('2026-10-14T09:00:00.000Z'),
    } as StudioCopyrightClaim;

    it('answers a listener 410 for a withheld track after the release checks pass', async () => {
      tracks.findOne.mockResolvedValue(withheldTrack);
      releases.createQueryBuilder
        .mockReturnValueOnce(queryBuilderMock({ one: releaseRow(1) }))
        .mockReturnValueOnce(queryBuilderMock({ exists: true }));

      const failure = await thrownBy(service.getTrack(VIEWER_ID, TRACK_ID));

      expect(failure.getStatus()).toBe(410);
      expect(failure.getResponse()).toEqual({
        statusCode: 410,
        code: 'studio_track_withheld',
        message: 'This track is unavailable.',
      });
    });

    it('keeps the withdrawn release answer ahead of a withheld track', async () => {
      tracks.findOne.mockResolvedValue(withheldTrack);
      releases.createQueryBuilder
        .mockReturnValueOnce(
          queryBuilderMock({
            one: releaseRow(1, StudioReleaseStatus.TakenDown),
          }),
        )
        .mockReturnValueOnce(queryBuilderMock({ exists: false }));
      subprofiles.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ exists: true }),
      );

      const failure = await thrownBy(service.getTrack(VIEWER_ID, TRACK_ID));

      expect(failure.getResponse()).toEqual(
        expect.objectContaining({ code: 'studio_release_withdrawn' }),
      );
    });

    it('shows the owner a withheld track with its claims', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      tracks.findOne.mockResolvedValue(withheldTrack);
      tracks.manager.find.mockResolvedValue([acceptedClaim]);
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1) }),
      );

      const response = await service.getTrack(VIEWER_ID, TRACK_ID);

      expect(response.isWithheld).toBe(true);
      expect(response.title).toBe('Borrowed');
      expect(response.claims).toEqual([
        expect.objectContaining({ id: acceptedClaim.id, canCounter: true }),
      ]);
      expect(tracks.manager.find).toHaveBeenCalledWith(
        StudioCopyrightClaim,
        expect.objectContaining({
          order: { acceptedAt: 'DESC', id: 'DESC' },
        }),
      );
    });

    it('reads no claims for a listener', async () => {
      tracks.findOne.mockResolvedValue({ ...withheldTrack, withheldAt: null });
      releases.createQueryBuilder
        .mockReturnValueOnce(queryBuilderMock({ one: releaseRow(1) }))
        .mockReturnValueOnce(queryBuilderMock({ exists: true }));

      const response = await service.getTrack(VIEWER_ID, TRACK_ID);

      expect(response.claims).toEqual([]);
      expect(tracks.manager.find).not.toHaveBeenCalled();
    });

    it('reads owner claims for every track of the release', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1) }),
      );
      tracks.find.mockResolvedValue([
        withheldTrack,
        {
          ...withheldTrack,
          id: 'cb200000-0000-4000-8000-000000000002',
          position: 2,
          withheldAt: null,
        },
      ]);
      tracks.manager.find.mockResolvedValue([acceptedClaim]);

      const response = await service.getRelease(VIEWER_ID, releaseRow(1).id);

      const [[, options]] = tracks.manager.find.mock.calls as [
        [unknown, { where: { trackId: { value: string[] } } }],
      ];
      expect(options.where.trackId.value).toEqual([
        TRACK_ID,
        'cb200000-0000-4000-8000-000000000002',
      ]);
      expect(response.claims).toHaveLength(1);
    });

    it('answers a listener 410 on the stream of a withheld track', async () => {
      tracks.findOne.mockResolvedValue(withheldTrack);
      releases.createQueryBuilder
        .mockReturnValueOnce(queryBuilderMock({ one: releaseRow(1) }))
        .mockReturnValueOnce(queryBuilderMock({ exists: true }));

      const failure = await thrownBy(service.getStream(VIEWER_ID, TRACK_ID));

      expect(failure.getStatus()).toBe(410);
      expect(storage.createPresignedAudioStream).not.toHaveBeenCalled();
    });

    it('lets the owner stream a withheld track', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      tracks.findOne.mockResolvedValue(withheldTrack);
      releases.createQueryBuilder.mockReturnValueOnce(
        queryBuilderMock({ one: releaseRow(1) }),
      );

      await service.getStream(VIEWER_ID, TRACK_ID);

      expect(storage.createPresignedAudioStream).toHaveBeenCalledWith(
        AUDIO_KEY,
        'audio/mpeg',
        200,
      );
    });

    it('leaves withheld tracks out of track search', async () => {
      const queryBuilder = queryBuilderMock();
      tracks.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.search(VIEWER_ID, 'opening', 'tracks');

      expect(andWherePredicates(queryBuilder)).toContain(
        notWithheldTrackSql('track'),
      );
    });

    it('leaves a withheld length out of a listener card and keeps it in the count', async () => {
      const queryBuilder = queryBuilderMock();
      tracks.createQueryBuilder.mockReturnValue(queryBuilder);
      releases.createQueryBuilder.mockReturnValue(
        queryBuilderMock({ many: [releaseRow(1)] }),
      );

      await service.staffSummariesByReleaseId([releaseRow(1).id]);

      expect(LISTENER_HEARD_TRACK_FILTER_SQL).toContain(
        notWithheldTrackSql('track'),
      );
      expect(queryBuilder.addSelect).toHaveBeenCalledWith(
        `COALESCE(SUM("track"."duration_seconds") FILTER (WHERE ${LISTENER_HEARD_TRACK_FILTER_SQL}), 0)::int`,
        'playable_duration_seconds',
      );
      expect(queryBuilder.addSelect).toHaveBeenCalledWith(
        `COUNT(*) FILTER (WHERE ${LISTENER_PLAYABLE_TRACK_FILTER_SQL})::int`,
        'playable_track_count',
      );
    });
  });
});

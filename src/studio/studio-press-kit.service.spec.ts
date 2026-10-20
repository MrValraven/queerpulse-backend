import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { SubprofileSocialLink } from '../subprofiles/entities/subprofile-social-link.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { StudioPressKit } from './entities/studio-press-kit.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { episodeReleasedSql } from './studio-episode-rule';
import { StudioOwnershipService } from './studio-ownership.service';
import { notWithheldTrackSql } from './studio-playlist-visibility';
import { StudioPressKitService } from './studio-press-kit.service';

const VIEWER_ID = 'db000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'db000000-0000-4000-8000-000000000002';
const RELEASE_ID = 'db000000-0000-4000-8000-000000000003';
const FIRST_TRACK = 'db000000-0000-4000-8000-000000000004';
const SECOND_TRACK = 'db000000-0000-4000-8000-000000000005';
const AUDIO_KEY = 'studio-audio/a/b.mp3';

function queryBuilderMock(result: { many?: unknown[]; exists?: boolean }) {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of [
    'innerJoin',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
  ]) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getMany = jest.fn().mockResolvedValue(result.many ?? []);
  queryBuilder.getExists = jest.fn().mockResolvedValue(result.exists ?? false);
  return queryBuilder;
}

const trackRow = (id: string, position: number) => ({
  id,
  releaseId: RELEASE_ID,
  position,
  title: `Track ${position}`,
  audioKey: AUDIO_KEY,
  durationSeconds: 200,
  isExplicit: false,
});

describe('StudioPressKitService', () => {
  let query: jest.Mock;
  let subprofiles: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let pressKits: { findOne: jest.Mock; upsert: jest.Mock };
  let socialLinks: { find: jest.Mock };
  let releases: { find: jest.Mock };
  let tracks: { createQueryBuilder: jest.Mock };
  let ownership: { isPersonaMember: jest.Mock; assertArtistPersona: jest.Mock };
  let catalog: { cardsByReleaseId: jest.Mock };
  let blockFilter: { excludeBlocked: jest.Mock };
  let service: StudioPressKitService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    subprofiles = {
      findOne: jest.fn().mockResolvedValue({
        id: PERSONA_ID,
        handle: 'night-shift',
        displayName: 'Night Shift',
        kind: 'dj',
        avatarUrl: null,
        bio: 'Sets from the river.',
      }),
      createQueryBuilder: jest.fn(() => queryBuilderMock({ exists: true })),
    };
    pressKits = {
      findOne: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
    };
    socialLinks = { find: jest.fn().mockResolvedValue([]) };
    releases = {
      find: jest
        .fn()
        .mockResolvedValue([
          { id: RELEASE_ID, status: StudioReleaseStatus.Published },
        ]),
    };
    tracks = {
      createQueryBuilder: jest.fn(() =>
        queryBuilderMock({ many: [trackRow(FIRST_TRACK, 1)] }),
      ),
    };
    ownership = {
      isPersonaMember: jest.fn().mockResolvedValue(false),
      assertArtistPersona: jest
        .fn()
        .mockResolvedValue({ id: PERSONA_ID, kind: 'dj' }),
    };
    catalog = {
      cardsByReleaseId: jest.fn((releaseIds: string[]) =>
        Promise.resolve(
          new Map(
            releaseIds.map((releaseId) => [
              releaseId,
              { id: releaseId, title: 'Lisbon at four' },
            ]),
          ),
        ),
      ),
    };
    blockFilter = { excludeBlocked: jest.fn() };
    service = new StudioPressKitService(
      { query } as unknown as DataSource,
      subprofiles as unknown as Repository<Subprofile>,
      pressKits as unknown as Repository<StudioPressKit>,
      socialLinks as unknown as Repository<SubprofileSocialLink>,
      releases as unknown as Repository<StudioRelease>,
      tracks as unknown as Repository<StudioTrack>,
      ownership as unknown as StudioOwnershipService,
      catalog as unknown as StudioCatalogService,
      blockFilter as unknown as BlockFilterService,
    );
  });

  describe('getPressKit', () => {
    it('answers 404 for a persona of another kind, owners included', async () => {
      subprofiles.findOne.mockResolvedValue({
        id: PERSONA_ID,
        kind: 'writer',
      });
      ownership.isPersonaMember.mockResolvedValue(true);
      await expect(
        service.getPressKit(VIEWER_ID, PERSONA_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers a visitor 404 when the persona is not listenable to them', async () => {
      subprofiles.createQueryBuilder.mockReturnValue(
        queryBuilderMock({ exists: false }),
      );
      await expect(
        service.getPressKit(VIEWER_ID, PERSONA_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('falls back to the newest playable tracks when the artist chose none', async () => {
      const fallback = queryBuilderMock({
        many: [trackRow(FIRST_TRACK, 1), trackRow(SECOND_TRACK, 2)],
      });
      tracks.createQueryBuilder.mockReturnValue(fallback);

      const pressKit = await service.getPressKit(VIEWER_ID, PERSONA_ID);

      expect(pressKit.isFeaturedFallback).toBe(true);
      expect(pressKit.featuredTracks.map((track) => track.id)).toEqual([
        FIRST_TRACK,
        SECOND_TRACK,
      ]);
      expect(fallback.limit).toHaveBeenCalledWith(5);
      expect(fallback.orderBy).toHaveBeenCalledWith(
        'release.publishedAt',
        'DESC',
      );
      expect(pressKit.bio).toBe('Sets from the river.');
      expect(pressKit.owner).toBeNull();
    });

    it('keeps the chosen tracks in the stored order and drops the unplayable ones', async () => {
      pressKits.findOne.mockResolvedValue({
        subprofileId: PERSONA_ID,
        featuredTrackIds: [
          SECOND_TRACK,
          'db000000-0000-4000-8000-0000000000ff',
          FIRST_TRACK,
        ],
        quotes: [],
        updatedAt: new Date('2026-10-12T09:00:00.000Z'),
      });
      const chosen = queryBuilderMock({
        many: [trackRow(FIRST_TRACK, 1), trackRow(SECOND_TRACK, 2)],
      });
      tracks.createQueryBuilder.mockReturnValue(chosen);

      const pressKit = await service.getPressKit(VIEWER_ID, PERSONA_ID);

      expect(pressKit.isFeaturedFallback).toBe(false);
      expect(pressKit.featuredTracks.map((track) => track.id)).toEqual([
        SECOND_TRACK,
        FIRST_TRACK,
      ]);
      expect(chosen.where).toHaveBeenCalledWith(
        'track.id IN (:...featuredTrackIds)',
        {
          featuredTrackIds: [
            SECOND_TRACK,
            'db000000-0000-4000-8000-0000000000ff',
            FIRST_TRACK,
          ],
        },
      );
    });

    // Studio artist kinds.
    it('keeps draft episodes out of the chosen and the fallback tracks', async () => {
      const fallback = queryBuilderMock({ many: [trackRow(FIRST_TRACK, 1)] });
      tracks.createQueryBuilder.mockReturnValue(fallback);
      await service.getPressKit(VIEWER_ID, PERSONA_ID);
      expect(
        fallback.andWhere!.mock.calls.map(([predicate]) => String(predicate)),
      ).toContain(episodeReleasedSql('track', 'release'));

      pressKits.findOne.mockResolvedValue({
        subprofileId: PERSONA_ID,
        featuredTrackIds: [FIRST_TRACK],
        quotes: [],
        updatedAt: new Date('2026-10-12T09:00:00.000Z'),
      });
      const chosen = queryBuilderMock({ many: [trackRow(FIRST_TRACK, 1)] });
      tracks.createQueryBuilder.mockReturnValue(chosen);
      await service.getPressKit(VIEWER_ID, PERSONA_ID);
      expect(
        chosen.andWhere!.mock.calls.map(([predicate]) => String(predicate)),
      ).toContain(episodeReleasedSql('track', 'release'));
    });

    // Studio safety and moderation.
    it('keeps withheld tracks out of the chosen and the fallback tracks', async () => {
      const fallback = queryBuilderMock({ many: [trackRow(FIRST_TRACK, 1)] });
      tracks.createQueryBuilder.mockReturnValue(fallback);
      await service.getPressKit(VIEWER_ID, PERSONA_ID);
      expect(
        fallback.andWhere!.mock.calls.map(([predicate]) => String(predicate)),
      ).toContain(notWithheldTrackSql('track'));

      pressKits.findOne.mockResolvedValue({
        subprofileId: PERSONA_ID,
        featuredTrackIds: [FIRST_TRACK],
        quotes: [],
        updatedAt: new Date('2026-10-12T09:00:00.000Z'),
      });
      const chosen = queryBuilderMock({ many: [trackRow(FIRST_TRACK, 1)] });
      tracks.createQueryBuilder.mockReturnValue(chosen);
      await service.getPressKit(VIEWER_ID, PERSONA_ID);
      expect(
        chosen.andWhere!.mock.calls.map(([predicate]) => String(predicate)),
      ).toContain(notWithheldTrackSql('track'));
    });

    it('lists the latest six published releases', async () => {
      await service.getPressKit(VIEWER_ID, PERSONA_ID);
      expect(releases.find).toHaveBeenCalledWith({
        where: { subprofileId: PERSONA_ID, status: 'published' },
        order: { publishedAt: 'DESC', id: 'DESC' },
        take: 6,
      });
    });

    it('lets an owner read without the listenable check and returns the owner fields', async () => {
      ownership.isPersonaMember.mockResolvedValue(true);
      const pressKit = await service.getPressKit(VIEWER_ID, PERSONA_ID);
      expect(subprofiles.createQueryBuilder).not.toHaveBeenCalled();
      expect(pressKit.isOwner).toBe(true);
      expect(pressKit.owner).toEqual(
        expect.objectContaining({ featuredTrackIds: [], updatedAt: null }),
      );
    });
  });

  describe('updatePressKit', () => {
    const body = {
      pitch: '',
      pressBio: 'A press bio.',
      featuredTrackIds: [FIRST_TRACK.toUpperCase()],
      quotes: [{ quote: 'Hypnotic', source: 'Rádio Quântica' }],
      contact: null,
    };

    it('refuses a featured track outside this artist releases with 422', async () => {
      query.mockResolvedValue([]);
      try {
        await service.updatePressKit(VIEWER_ID, PERSONA_ID, body);
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(422);
        expect((error as HttpException).getResponse()).toEqual(
          expect.objectContaining({ code: 'studio_press_track_not_allowed' }),
        );
      }
      expect(pressKits.upsert).not.toHaveBeenCalled();
    });

    it('stores an empty pitch as null and lowercased track ids, then answers the press kit', async () => {
      query.mockResolvedValue([{ id: FIRST_TRACK }]);
      ownership.isPersonaMember.mockResolvedValue(true);

      await service.updatePressKit(VIEWER_ID, PERSONA_ID, body);

      expect(query.mock.calls[0]?.[1]).toEqual([[FIRST_TRACK], PERSONA_ID]);
      expect(pressKits.upsert).toHaveBeenCalledWith(
        {
          subprofileId: PERSONA_ID,
          pitch: null,
          pressBio: 'A press bio.',
          featuredTrackIds: [FIRST_TRACK],
          quotes: [{ quote: 'Hypnotic', source: 'Rádio Quântica' }],
          contact: null,
          updatedAt: expect.any(Date) as Date,
        },
        ['subprofileId'],
      );
    });

    it('refuses a member who does not run the persona before reading anything', async () => {
      ownership.assertArtistPersona.mockRejectedValue(new ForbiddenException());
      await expect(
        service.updatePressKit(VIEWER_ID, PERSONA_ID, body),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(query).not.toHaveBeenCalled();
    });
  });
});

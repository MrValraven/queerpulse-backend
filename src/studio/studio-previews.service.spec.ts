import { HttpException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { StorageService } from '../storage/storage.service';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { STUDIO_PREVIEW_TOKEN_PATTERN } from './studio-preview-token';
import { StudioPreviewsService } from './studio-previews.service';
import { studioError } from './studio.constants';

const USER_ID = 'd6000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'd6000000-0000-4000-8000-000000000002';
const TRACK_ID = 'd6000000-0000-4000-8000-000000000003';
const TOKEN = 'b'.repeat(64);
const AUDIO_KEY = 'studio-audio/a/b.mp3';
const PREVIEW_NOT_FOUND_BODY = {
  statusCode: 404,
  code: 'studio_preview_not_found',
  message: 'This preview link is not available.',
};

async function failureOf(
  promise: Promise<unknown>,
): Promise<{ status: number; body: unknown } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    const exception = error as HttpException;
    return { status: exception.getStatus(), body: exception.getResponse() };
  }
}

function previewQueryBuilder(release: Partial<StudioRelease> | null) {
  const queryBuilder = {
    innerJoin: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    getOne: jest.fn().mockResolvedValue(release),
  };
  queryBuilder.innerJoin.mockReturnValue(queryBuilder);
  queryBuilder.where.mockReturnValue(queryBuilder);
  queryBuilder.andWhere.mockReturnValue(queryBuilder);
  return queryBuilder;
}

describe('StudioPreviewsService', () => {
  let lockedRelease: Partial<StudioRelease>;
  let manager: { save: jest.Mock };
  let releases: { createQueryBuilder: jest.Mock };
  let tracks: { findOne: jest.Mock };
  let ownership: { lockReleaseForWrite: jest.Mock };
  let catalog: { getReleaseAsPreview: jest.Mock };
  let blockFilter: { excludeBlocked: jest.Mock };
  let storage: { createPresignedAudioStream: jest.Mock };
  let service: StudioPreviewsService;

  beforeEach(() => {
    lockedRelease = {
      id: RELEASE_ID,
      status: StudioReleaseStatus.Draft,
      previewToken: null,
      previewLinkCreatedAt: null,
    };
    manager = { save: jest.fn((row: unknown) => Promise.resolve(row)) };
    releases = {
      createQueryBuilder: jest.fn(() =>
        previewQueryBuilder({
          id: RELEASE_ID,
          status: StudioReleaseStatus.Draft,
        }),
      ),
    };
    tracks = {
      findOne: jest.fn().mockResolvedValue({
        id: TRACK_ID,
        releaseId: RELEASE_ID,
        audioKey: AUDIO_KEY,
        audioContentType: 'audio/mpeg',
        durationSeconds: 200,
        waveformPeaks: [0, 128, 255],
        loudnessLufs: -14.2,
        peakDb: -1.3,
      }),
    };
    ownership = {
      lockReleaseForWrite: jest.fn(() =>
        Promise.resolve({
          release: lockedRelease,
          persona: { id: 'persona-1', kind: 'dj' },
        }),
      ),
    };
    catalog = {
      getReleaseAsPreview: jest
        .fn()
        .mockResolvedValue({ id: RELEASE_ID, isPreview: true }),
    };
    blockFilter = { excludeBlocked: jest.fn() };
    storage = {
      createPresignedAudioStream: jest.fn().mockResolvedValue({
        url: 'https://bucket.example/stream',
        expiresAt: '2026-10-13T12:15:00.000Z',
      }),
    };
    const dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
    };
    service = new StudioPreviewsService(
      dataSource as unknown as DataSource,
      releases as unknown as Repository<StudioRelease>,
      tracks as unknown as Repository<StudioTrack>,
      ownership as unknown as StudioOwnershipService,
      catalog as unknown as StudioCatalogService,
      blockFilter as unknown as BlockFilterService,
      storage as unknown as StorageService,
    );
  });

  describe('mintLink', () => {
    it('mints a link on a draft and answers the token and its date', async () => {
      const link = await service.mintLink(USER_ID, RELEASE_ID);
      expect(link.token).toMatch(STUDIO_PREVIEW_TOKEN_PATTERN);
      expect(new Date(link.createdAt).toISOString()).toBe(link.createdAt);
      const saved = manager.save.mock.calls[0]![0] as StudioRelease;
      expect(saved.previewToken).toBe(link.token);
    });

    it('replaces the old link with a new one', async () => {
      lockedRelease = { ...lockedRelease, previewToken: TOKEN };
      const link = await service.mintLink(USER_ID, RELEASE_ID);
      expect(link.token).not.toBe(TOKEN);
      const saved = manager.save.mock.calls[0]![0] as StudioRelease;
      expect(saved.previewToken).toBe(link.token);
    });

    it('mints on a scheduled release', async () => {
      lockedRelease = {
        ...lockedRelease,
        status: StudioReleaseStatus.Scheduled,
      };
      await expect(service.mintLink(USER_ID, RELEASE_ID)).resolves.toEqual(
        expect.objectContaining({ token: expect.any(String) as unknown }),
      );
    });

    it.each([[StudioReleaseStatus.Published], [StudioReleaseStatus.TakenDown]])(
      'refuses a %s release',
      async (status) => {
        lockedRelease = { ...lockedRelease, status };
        const failure = await failureOf(service.mintLink(USER_ID, RELEASE_ID));
        expect(failure?.status).toBe(409);
        expect(failure?.body).toEqual(
          expect.objectContaining({ code: 'studio_preview_not_available' }),
        );
        expect(manager.save).not.toHaveBeenCalled();
      },
    );
  });

  describe('revokeLink', () => {
    it('turns the link off', async () => {
      lockedRelease = {
        ...lockedRelease,
        previewToken: TOKEN,
        previewLinkCreatedAt: new Date(),
      };
      await service.revokeLink(USER_ID, RELEASE_ID);
      const saved = manager.save.mock.calls[0]![0] as StudioRelease;
      expect(saved.previewToken).toBeNull();
      expect(saved.previewLinkCreatedAt).toBeNull();
    });

    it('changes nothing when no link is on', async () => {
      await service.revokeLink(USER_ID, RELEASE_ID);
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('getPreview', () => {
    it('answers a draft or scheduled release through the preview read', async () => {
      const result = await service.getPreview(USER_ID, TOKEN);
      expect(result).toEqual({
        release: { id: RELEASE_ID, isPreview: true },
        publishedReleaseId: null,
      });
      expect(catalog.getReleaseAsPreview).toHaveBeenCalledWith(
        USER_ID,
        RELEASE_ID,
      );
    });

    it('answers the release id once it is out', async () => {
      releases.createQueryBuilder.mockReturnValue(
        previewQueryBuilder({
          id: RELEASE_ID,
          status: StudioReleaseStatus.Published,
        }),
      );
      expect(await service.getPreview(USER_ID, TOKEN)).toEqual({
        release: null,
        publishedReleaseId: RELEASE_ID,
      });
      expect(catalog.getReleaseAsPreview).not.toHaveBeenCalled();
    });

    it('answers the preview 404 body when the release vanishes before the read', async () => {
      catalog.getReleaseAsPreview.mockRejectedValueOnce(
        new NotFoundException('Release not found'),
      );
      expect(await failureOf(service.getPreview(USER_ID, TOKEN))).toEqual({
        status: 404,
        body: {
          statusCode: 404,
          code: 'studio_preview_not_found',
          message: 'This preview link is not available.',
        },
      });
    });

    it('answers the preview 404 body when the release is withdrawn before the read', async () => {
      catalog.getReleaseAsPreview.mockRejectedValueOnce(
        studioError('studio_release_withdrawn'),
      );
      expect(await failureOf(service.getPreview(USER_ID, TOKEN))).toEqual({
        status: 404,
        body: PREVIEW_NOT_FOUND_BODY,
      });
    });

    it('lets any other read failure through unchanged', async () => {
      const failure = new Error('database unavailable');
      catalog.getReleaseAsPreview.mockRejectedValueOnce(failure);
      await expect(service.getPreview(USER_ID, TOKEN)).rejects.toBe(failure);
    });

    it('looks the token up with the persona gate and the block filter', async () => {
      const queryBuilder = previewQueryBuilder({
        id: RELEASE_ID,
        status: StudioReleaseStatus.Draft,
      });
      releases.createQueryBuilder.mockReturnValue(queryBuilder);
      await service.getPreview(USER_ID, TOKEN);
      expect(queryBuilder.where).toHaveBeenCalledWith(
        '"release"."preview_token" = :previewToken',
        { previewToken: TOKEN },
      );
      const predicates = queryBuilder.andWhere.mock.calls.map(
        ([predicate]: [string]) => predicate,
      );
      expect(
        predicates.some((predicate) =>
          predicate.includes('"removed_at" IS NULL'),
        ),
      ).toBe(true);
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        queryBuilder,
        USER_ID,
        '"persona"."user_id"',
      );
    });
  });

  // Review Focus 4: a token is never an oracle.
  it('answers every failure with the same 404 body', async () => {
    const expected = {
      status: 404,
      body: {
        statusCode: 404,
        code: 'studio_preview_not_found',
        message: 'This preview link is not available.',
      },
    };
    // A malformed token never reaches the database.
    expect(await failureOf(service.getPreview(USER_ID, 'nope'))).toEqual(
      expected,
    );
    expect(releases.createQueryBuilder).not.toHaveBeenCalled();
    // Revoked, unknown, persona removed or taken down, creator blocked: no row.
    releases.createQueryBuilder.mockReturnValue(previewQueryBuilder(null));
    expect(await failureOf(service.getPreview(USER_ID, TOKEN))).toEqual(
      expected,
    );
    // A taken-down release.
    releases.createQueryBuilder.mockReturnValue(
      previewQueryBuilder({
        id: RELEASE_ID,
        status: StudioReleaseStatus.TakenDown,
      }),
    );
    expect(await failureOf(service.getPreview(USER_ID, TOKEN))).toEqual(
      expected,
    );
    // A wrong or malformed track id on the stream route.
    releases.createQueryBuilder.mockReturnValue(
      previewQueryBuilder({
        id: RELEASE_ID,
        status: StudioReleaseStatus.Draft,
      }),
    );
    tracks.findOne.mockResolvedValueOnce(null);
    expect(
      await failureOf(service.getPreviewStream(USER_ID, TOKEN, TRACK_ID)),
    ).toEqual(expected);
    expect(
      await failureOf(service.getPreviewStream(USER_ID, TOKEN, 'not-a-uuid')),
    ).toEqual(expected);
  });

  describe('getPreviewStream', () => {
    it('streams a track of the previewed release', async () => {
      expect(
        await service.getPreviewStream(USER_ID, TOKEN, TRACK_ID.toUpperCase()),
      ).toEqual({
        url: 'https://bucket.example/stream',
        expiresAt: '2026-10-13T12:15:00.000Z',
        waveformPeaks: [0, 128, 255],
        loudnessLufs: -14.2,
        peakDb: -1.3,
      });
      expect(tracks.findOne).toHaveBeenCalledWith({
        where: { id: TRACK_ID, releaseId: RELEASE_ID },
      });
      expect(storage.createPresignedAudioStream).toHaveBeenCalledWith(
        AUDIO_KEY,
        'audio/mpeg',
        200,
      );
    });

    it('streams nothing once the release is out, nor a track still uploading', async () => {
      releases.createQueryBuilder.mockReturnValue(
        previewQueryBuilder({
          id: RELEASE_ID,
          status: StudioReleaseStatus.Published,
        }),
      );
      expect(
        await failureOf(service.getPreviewStream(USER_ID, TOKEN, TRACK_ID)),
      ).toEqual({ status: 404, body: PREVIEW_NOT_FOUND_BODY });
      releases.createQueryBuilder.mockReturnValue(
        previewQueryBuilder({
          id: RELEASE_ID,
          status: StudioReleaseStatus.Draft,
        }),
      );
      tracks.findOne.mockResolvedValueOnce({
        id: TRACK_ID,
        releaseId: RELEASE_ID,
        audioKey: null,
        audioContentType: null,
        durationSeconds: null,
      });
      expect(
        await failureOf(service.getPreviewStream(USER_ID, TOKEN, TRACK_ID)),
      ).toEqual({ status: 404, body: PREVIEW_NOT_FOUND_BODY });
      expect(storage.createPresignedAudioStream).not.toHaveBeenCalled();
    });
  });
});

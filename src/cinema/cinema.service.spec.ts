import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { CinemaService } from './cinema.service';
import {
  CinemaTitle,
  TitleKind,
  TitleStatus,
} from './entities/cinema-title.entity';
import { WatchProgress } from './entities/watch-progress.entity';
import { MuxService } from './mux.service';

const member: CurrentUserData = {
  userId: 'user-1',
  email: 'm@example.com',
  status: 'active',
  role: 'member',
};
const moderator: CurrentUserData = {
  ...member,
  userId: 'mod-1',
  role: 'moderator',
};

const PLAYBACK_TOKENS = {
  hlsUrl: 'https://stream.mux.com/pb-1.m3u8?token=tok',
  posterUrl: 'https://image.mux.com/pb-1/thumbnail.webp?token=tok',
  storyboardUrl: 'https://image.mux.com/pb-1/storyboard.vtt?token=tok',
  expiresAt: new Date('2026-07-04T21:00:00Z'),
};

function makeTitle(overrides: Partial<CinemaTitle> = {}): CinemaTitle {
  return {
    id: 'title-1',
    kind: TitleKind.Film,
    title: 'My Film',
    description: null,
    coverImageUrl: null,
    status: TitleStatus.Ready,
    errorMessage: null,
    muxUploadId: 'up-1',
    muxAssetId: 'as-1',
    muxPlaybackId: 'pb-1',
    pendingMuxUploadId: null,
    pendingMuxAssetId: null,
    lastIngestEventAt: null,
    durationSeconds: 7200,
    aspectRatio: '16:9',
    publishedAt: new Date('2026-07-01T00:00:00Z'),
    viewCount: 0,
    createdBy: null,
    createdAt: new Date('2026-06-30T00:00:00Z'),
    updatedAt: new Date('2026-06-30T00:00:00Z'),
    ...overrides,
  };
}

describe('CinemaService', () => {
  let service: CinemaService;
  let titles: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
  };
  let progress: { findOne: jest.Mock; find: jest.Mock; upsert: jest.Mock };
  let mux: {
    signPlaybackTokens: jest.Mock;
    deleteAsset: jest.Mock;
    createDirectUpload: jest.Mock;
    getAsset: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let updateExecute: jest.Mock;
  let manager: { createQueryBuilder: jest.Mock; increment: jest.Mock };

  const savedTitle = (): CinemaTitle =>
    (titles.save.mock.calls as [CinemaTitle][])[0][0];
  const findArg = (): { where?: { status?: TitleStatus } } =>
    (titles.find.mock.calls as [{ where?: { status?: TitleStatus } }][])[0][0];

  beforeEach(async () => {
    titles = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation((t: CinemaTitle) => t),
      save: jest
        .fn()
        .mockImplementation((t: CinemaTitle) => Promise.resolve(t)),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    progress = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue(undefined),
    };
    mux = {
      signPlaybackTokens: jest.fn().mockResolvedValue(PLAYBACK_TOKENS),
      deleteAsset: jest.fn().mockResolvedValue(undefined),
      createDirectUpload: jest.fn().mockResolvedValue({
        uploadId: 'up-new',
        uploadUrl: 'https://storage.mux.com/put',
      }),
      getAsset: jest.fn(),
    };
    updateExecute = jest.fn().mockResolvedValue({ affected: 1 });
    const updateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: updateExecute,
    };
    manager = {
      createQueryBuilder: jest.fn().mockReturnValue(updateQb),
      increment: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation((cb: (m: typeof manager) => Promise<unknown>) =>
          cb(manager),
        ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CinemaService,
        { provide: getRepositoryToken(CinemaTitle), useValue: titles },
        { provide: getRepositoryToken(WatchProgress), useValue: progress },
        { provide: MuxService, useValue: mux },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(CinemaService);
  });

  describe('createPlaybackSession', () => {
    it('returns a session for a member on a published ready title', async () => {
      titles.findOne.mockResolvedValue(makeTitle());
      const session = await service.createPlaybackSession(member, 'title-1');
      expect(mux.signPlaybackTokens).toHaveBeenCalledWith('pb-1', 7200);
      expect(session).toEqual({
        ...PLAYBACK_TOKENS,
        resumePositionSeconds: 0,
        durationSeconds: 7200,
      });
    });

    it('rejects a member on an unpublished ready title with 404', async () => {
      titles.findOne.mockResolvedValue(makeTitle({ publishedAt: null }));
      await expect(
        service.createPlaybackSession(member, 'title-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mux.signPlaybackTokens).not.toHaveBeenCalled();
    });

    it('rejects a member on a non-ready title with 404', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({ status: TitleStatus.Processing }),
      );
      await expect(
        service.createPlaybackSession(member, 'title-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an unknown title with 404', async () => {
      titles.findOne.mockResolvedValue(null);
      await expect(
        service.createPlaybackSession(member, 'nope'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets a moderator preview an unpublished ready title', async () => {
      titles.findOne.mockResolvedValue(makeTitle({ publishedAt: null }));
      const session = await service.createPlaybackSession(moderator, 'title-1');
      expect(session.hlsUrl).toBe(PLAYBACK_TOKENS.hlsUrl);
    });

    it('409s when a ready title has no playback id (defensive)', async () => {
      titles.findOne.mockResolvedValue(makeTitle({ muxPlaybackId: null }));
      await expect(
        service.createPlaybackSession(member, 'title-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('resumes from the saved position', async () => {
      titles.findOne.mockResolvedValue(makeTitle());
      progress.findOne.mockResolvedValue({ positionSeconds: 1284 });
      const session = await service.createPlaybackSession(member, 'title-1');
      expect(session.resumePositionSeconds).toBe(1284);
    });

    it('restarts from zero when saved position is inside the final 3%', async () => {
      titles.findOne.mockResolvedValue(makeTitle({ durationSeconds: 7200 }));
      progress.findOne.mockResolvedValue({ positionSeconds: 7000 }); // > 6984 = 97%
      const session = await service.createPlaybackSession(member, 'title-1');
      expect(session.resumePositionSeconds).toBe(0);
    });
  });

  describe('listTitles', () => {
    it('rejects includeAll for a plain member', async () => {
      await expect(service.listTitles(member, true)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(titles.find).not.toHaveBeenCalled();
    });

    it('lists all statuses for a moderator with includeAll, exposing admin fields', async () => {
      titles.find.mockResolvedValue([
        makeTitle({
          status: TitleStatus.Failed,
          publishedAt: null,
          errorMessage: 'bad codec',
        }),
      ]);
      const result = await service.listTitles(moderator, true);
      expect(result).toHaveLength(1);
      expect(findArg().where).toBeUndefined();
      // Admin list must distinguish drafts/processing/failed titles.
      expect(result[0].status).toBe(TitleStatus.Failed);
      expect(result[0].errorMessage).toBe('bad codec');
    });

    it('omits admin fields from the member-facing list', async () => {
      titles.find.mockResolvedValue([makeTitle()]);
      const result = await service.listTitles(member, false);
      expect(result[0].status).toBeUndefined();
      expect(result[0].errorMessage).toBeUndefined();
    });

    it('lists only published ready titles for members, with progress merged', async () => {
      titles.find.mockResolvedValue([makeTitle()]);
      progress.find.mockResolvedValue([
        { titleId: 'title-1', positionSeconds: 7100, viewCountedAt: null },
      ]);
      const result = await service.listTitles(member, false);
      expect(result).toHaveLength(1);
      expect(result[0].myProgress).toEqual({
        positionSeconds: 7100,
        finished: true, // 7100 >= 97% of 7200
      });
      expect(findArg().where?.status).toBe(TitleStatus.Ready);
    });

    it('returns null progress when the member has none', async () => {
      titles.find.mockResolvedValue([makeTitle()]);
      progress.find.mockResolvedValue([]);
      const result = await service.listTitles(member, false);
      expect(result[0].myProgress).toBeNull();
    });
  });

  describe('requestUpload', () => {
    it('mints an upload for a draft and moves it to awaiting_upload', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({
          status: TitleStatus.Draft,
          publishedAt: null,
          muxUploadId: null,
          muxAssetId: null,
          muxPlaybackId: null,
        }),
      );
      const result = await service.requestUpload('title-1');
      expect(mux.createDirectUpload).toHaveBeenCalledWith('title-1');
      expect(result).toEqual({
        uploadId: 'up-new',
        uploadUrl: 'https://storage.mux.com/put',
      });
      const saved = savedTitle();
      expect(saved.status).toBe(TitleStatus.AwaitingUpload);
      expect(saved.muxUploadId).toBe('up-new');
    });

    it('cleans up the orphaned asset when retrying a failed title', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({
          status: TitleStatus.Failed,
          publishedAt: null,
          muxAssetId: 'as-old',
          errorMessage: 'bad codec',
        }),
      );
      await service.requestUpload('title-1');
      expect(mux.deleteAsset).toHaveBeenCalledWith('as-old');
      const saved = savedTitle();
      expect(saved.status).toBe(TitleStatus.AwaitingUpload);
      expect(saved.muxAssetId).toBeNull();
      expect(saved.errorMessage).toBeNull();
    });

    it('stages a replacement upload for a ready title without touching the live asset', async () => {
      titles.findOne.mockResolvedValue(makeTitle());
      await service.requestUpload('title-1');
      const saved = savedTitle();
      expect(saved.pendingMuxUploadId).toBe('up-new');
      expect(saved.status).toBe(TitleStatus.Ready);
      expect(saved.muxUploadId).toBe('up-1');
      expect(saved.muxAssetId).toBe('as-1');
      expect(mux.deleteAsset).not.toHaveBeenCalled();
    });

    it('drops a superseded pending asset before staging another replacement', async () => {
      // A prior replacement already produced a pending asset; re-uploading must
      // delete it at Mux so the abandoned asset is not billed forever.
      titles.findOne.mockResolvedValue(
        makeTitle({
          pendingMuxUploadId: 'up-old',
          pendingMuxAssetId: 'as-old',
        }),
      );
      await service.requestUpload('title-1');
      expect(mux.deleteAsset).toHaveBeenCalledWith('as-old');
      const saved = savedTitle();
      expect(saved.pendingMuxUploadId).toBe('up-new');
      expect(saved.pendingMuxAssetId).toBeNull();
      expect(saved.muxAssetId).toBe('as-1'); // live asset untouched
      expect(saved.status).toBe(TitleStatus.Ready);
    });

    it('409s while an upload is processing', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({ status: TitleStatus.Processing, publishedAt: null }),
      );
      await expect(service.requestUpload('title-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mux.createDirectUpload).not.toHaveBeenCalled();
    });
  });

  describe('webhook state transitions', () => {
    it('onUploadAssetCreated moves the main upload to processing', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({
          status: TitleStatus.AwaitingUpload,
          publishedAt: null,
          muxUploadId: 'up-1',
          muxAssetId: null,
          muxPlaybackId: null,
        }),
      );
      await service.onUploadAssetCreated('up-1', 'as-new');
      const saved = savedTitle();
      expect(saved.muxAssetId).toBe('as-new');
      expect(saved.status).toBe(TitleStatus.Processing);
    });

    it('onUploadAssetCreated records the pending asset without touching status', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({ pendingMuxUploadId: 'up-2' }),
      );
      await service.onUploadAssetCreated('up-2', 'as-2');
      const saved = savedTitle();
      expect(saved.pendingMuxAssetId).toBe('as-2');
      expect(saved.status).toBe(TitleStatus.Ready);
      expect(saved.muxAssetId).toBe('as-1');
    });

    it('onUploadAssetCreated ignores unknown uploads', async () => {
      titles.findOne.mockResolvedValue(null);
      await service.onUploadAssetCreated('up-unknown', 'as-x');
      expect(titles.save).not.toHaveBeenCalled();
    });

    it('onAssetReady stores playback metadata and readies the title', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({
          status: TitleStatus.Processing,
          publishedAt: null,
          muxAssetId: 'as-1',
          muxPlaybackId: null,
          durationSeconds: null,
        }),
      );
      await service.onAssetReady('as-1', {
        playbackId: 'pb-new',
        durationSeconds: 5400,
        aspectRatio: '16:9',
      });
      const saved = savedTitle();
      expect(saved.status).toBe(TitleStatus.Ready);
      expect(saved.muxPlaybackId).toBe('pb-new');
      expect(saved.durationSeconds).toBe(5400);
    });

    it('onAssetReady is a no-op on replay', async () => {
      titles.findOne.mockResolvedValue(makeTitle()); // already ready with pb-1
      await service.onAssetReady('as-1', {
        playbackId: 'pb-1',
        durationSeconds: 7200,
        aspectRatio: '16:9',
      });
      expect(titles.save).not.toHaveBeenCalled();
    });

    it('onAssetReady swaps a pending replacement and deletes the old asset', async () => {
      const publishedAt = new Date('2026-07-01T00:00:00Z');
      titles.findOne.mockResolvedValue(
        makeTitle({
          publishedAt,
          pendingMuxUploadId: 'up-2',
          pendingMuxAssetId: 'as-2',
        }),
      );
      await service.onAssetReady('as-2', {
        playbackId: 'pb-2',
        durationSeconds: 6000,
        aspectRatio: '4:3',
      });
      const saved = savedTitle();
      expect(saved.muxAssetId).toBe('as-2');
      expect(saved.muxUploadId).toBe('up-2');
      expect(saved.muxPlaybackId).toBe('pb-2');
      expect(saved.durationSeconds).toBe(6000);
      expect(saved.pendingMuxAssetId).toBeNull();
      expect(saved.pendingMuxUploadId).toBeNull();
      expect(saved.status).toBe(TitleStatus.Ready);
      expect(saved.publishedAt).toEqual(publishedAt); // stays published
      expect(mux.deleteAsset).toHaveBeenCalledWith('as-1');
    });

    it('onAssetErrored fails the main asset with the message', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({ status: TitleStatus.Processing, publishedAt: null }),
      );
      await service.onAssetErrored('as-1', 'bad codec');
      const saved = savedTitle();
      expect(saved.status).toBe(TitleStatus.Failed);
      expect(saved.errorMessage).toBe('bad codec');
    });

    it('onAssetErrored on a pending replacement keeps the live title intact', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({ pendingMuxUploadId: 'up-2', pendingMuxAssetId: 'as-2' }),
      );
      await service.onAssetErrored('as-2', 'bad codec');
      const saved = savedTitle();
      expect(saved.status).toBe(TitleStatus.Ready);
      expect(saved.muxAssetId).toBe('as-1');
      expect(saved.pendingMuxAssetId).toBeNull();
      expect(saved.pendingMuxUploadId).toBeNull();
      expect(saved.errorMessage).toContain('bad codec');
    });

    it('onUploadFailed fails the main upload', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({
          status: TitleStatus.AwaitingUpload,
          publishedAt: null,
          muxUploadId: 'up-1',
        }),
      );
      await service.onUploadFailed('up-1', 'video.upload.errored');
      const saved = savedTitle();
      expect(saved.status).toBe(TitleStatus.Failed);
      expect(saved.errorMessage).toBe('video.upload.errored');
    });

    it('onUploadFailed on a pending replacement clears only the pending ids', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({ pendingMuxUploadId: 'up-2' }),
      );
      await service.onUploadFailed('up-2', 'video.upload.cancelled');
      const saved = savedTitle();
      expect(saved.status).toBe(TitleStatus.Ready);
      expect(saved.pendingMuxUploadId).toBeNull();
    });

    it('rejects an on* transition with an empty provider id', async () => {
      await expect(
        service.onAssetReady('', {
          playbackId: 'pb',
          durationSeconds: 1,
          aspectRatio: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(titles.findOne).not.toHaveBeenCalled();
    });

    it('ignores a late asset.errored on a Ready/published title', async () => {
      // Main asset (as-1) errors after the title is already Ready — a stale or
      // replayed event must not yank a live title back to Failed.
      titles.findOne.mockResolvedValue(makeTitle()); // Ready, published, as-1
      await service.onAssetErrored('as-1', 'transient blip');
      expect(titles.save).not.toHaveBeenCalled();
    });

    it('ignores a late upload failure on a Ready/published title', async () => {
      titles.findOne.mockResolvedValue(makeTitle()); // Ready, published, up-1
      await service.onUploadFailed('up-1', 'video.upload.errored');
      expect(titles.save).not.toHaveBeenCalled();
    });
  });

  describe('syncAssetState (out-of-order heal)', () => {
    it('applies a ready asset that arrived before asset_created linked it', async () => {
      // asset_created just linked as-1 (title Processing); the earlier
      // asset.ready was dropped as "unknown". Polling now heals it.
      titles.findOne.mockResolvedValue(
        makeTitle({
          status: TitleStatus.Processing,
          publishedAt: null,
          muxAssetId: 'as-1',
          muxPlaybackId: null,
          durationSeconds: null,
        }),
      );
      mux.getAsset.mockResolvedValue({
        status: 'ready',
        playbackId: 'pb-late',
        durationSeconds: 4800,
        aspectRatio: '16:9',
        errorMessage: null,
      });
      await service.syncAssetState('as-1');
      expect(mux.getAsset).toHaveBeenCalledWith('as-1');
      const saved = savedTitle();
      expect(saved.status).toBe(TitleStatus.Ready);
      expect(saved.muxPlaybackId).toBe('pb-late');
      expect(saved.durationSeconds).toBe(4800);
    });

    it('fails the title when the polled asset already errored', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({
          status: TitleStatus.Processing,
          publishedAt: null,
          muxAssetId: 'as-1',
          muxPlaybackId: null,
        }),
      );
      mux.getAsset.mockResolvedValue({
        status: 'errored',
        playbackId: null,
        durationSeconds: null,
        aspectRatio: null,
        errorMessage: 'bad codec',
      });
      await service.syncAssetState('as-1');
      const saved = savedTitle();
      expect(saved.status).toBe(TitleStatus.Failed);
      expect(saved.errorMessage).toBe('bad codec');
    });

    it('does not poll a main asset that is already Ready', async () => {
      titles.findOne.mockResolvedValue(makeTitle()); // Ready, muxAssetId as-1
      await service.syncAssetState('as-1');
      expect(mux.getAsset).not.toHaveBeenCalled();
      expect(titles.save).not.toHaveBeenCalled();
    });

    it('ignores an unknown asset without polling', async () => {
      titles.findOne.mockResolvedValue(null);
      await service.syncAssetState('as-x');
      expect(mux.getAsset).not.toHaveBeenCalled();
    });
  });

  describe('admin CRUD', () => {
    it('creates a draft title owned by the caller', async () => {
      const detail = await service.createTitle(moderator, {
        kind: TitleKind.Short,
        title: 'New Short',
      });
      expect(titles.save).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: TitleKind.Short,
          title: 'New Short',
          status: TitleStatus.Draft,
          createdBy: { id: 'mod-1' },
        }),
      );
      expect(detail.status).toBe(TitleStatus.Draft);
    });

    it('refuses to publish a title that is not ready', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({ status: TitleStatus.Processing, publishedAt: null }),
      );
      await expect(
        service.updateTitle('title-1', { published: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(titles.save).not.toHaveBeenCalled();
    });

    it('refuses to publish a ready title with no playback id', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({ publishedAt: null, muxPlaybackId: null }),
      );
      await expect(
        service.updateTitle('title-1', { published: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(titles.save).not.toHaveBeenCalled();
    });

    it('publishes a ready title', async () => {
      titles.findOne.mockResolvedValue(makeTitle({ publishedAt: null }));
      const detail = await service.updateTitle('title-1', { published: true });
      expect(detail.publishedAt).toBeInstanceOf(Date);
    });

    it('keeps the original publish date when re-publishing', async () => {
      const original = new Date('2026-07-01T00:00:00Z');
      titles.findOne.mockResolvedValue(makeTitle({ publishedAt: original }));
      const detail = await service.updateTitle('title-1', { published: true });
      expect(detail.publishedAt).toEqual(original);
    });

    it('unpublishes a title', async () => {
      titles.findOne.mockResolvedValue(makeTitle());
      const detail = await service.updateTitle('title-1', { published: false });
      expect(detail.publishedAt).toBeNull();
    });

    it('404s when updating an unknown title', async () => {
      titles.findOne.mockResolvedValue(null);
      await expect(
        service.updateTitle('nope', { title: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deletes the row and both Mux assets', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({ muxAssetId: 'as-1', pendingMuxAssetId: 'as-2' }),
      );
      await service.deleteTitle('title-1');
      expect(mux.deleteAsset).toHaveBeenCalledWith('as-1');
      expect(mux.deleteAsset).toHaveBeenCalledWith('as-2');
      expect(titles.remove).toHaveBeenCalled();
    });

    it('still deletes the row when Mux asset deletion fails (best-effort)', async () => {
      titles.findOne.mockResolvedValue(makeTitle({ muxAssetId: 'as-1' }));
      mux.deleteAsset.mockRejectedValue(new Error('mux down'));
      await service.deleteTitle('title-1');
      expect(titles.remove).toHaveBeenCalled();
    });
  });

  describe('reportProgress', () => {
    it('upserts progress and counts a view when crossing the threshold', async () => {
      titles.findOne.mockResolvedValue(makeTitle());
      const result = await service.reportProgress(member, 'title-1', 90);
      expect(progress.upsert).toHaveBeenCalledWith(
        { userId: 'user-1', titleId: 'title-1', positionSeconds: 90 },
        { conflictPaths: ['userId', 'titleId'] },
      );
      expect(manager.increment).toHaveBeenCalledWith(
        CinemaTitle,
        { id: 'title-1' },
        'viewCount',
        1,
      );
      expect(result).toEqual({ positionSeconds: 90, viewCounted: true });
    });

    it('does not double-count when the view was already counted', async () => {
      titles.findOne.mockResolvedValue(makeTitle());
      updateExecute.mockResolvedValue({ affected: 0 });
      const result = await service.reportProgress(member, 'title-1', 90);
      expect(manager.increment).not.toHaveBeenCalled();
      expect(result.viewCounted).toBe(false);
    });

    it('skips view counting below the threshold', async () => {
      titles.findOne.mockResolvedValue(makeTitle());
      const result = await service.reportProgress(member, 'title-1', 45);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(result).toEqual({ positionSeconds: 45, viewCounted: false });
    });

    it('uses the 50%-of-duration arm for very short titles', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({ kind: TitleKind.Short, durationSeconds: 30 }),
      );
      // threshold = min(60, ceil(30 * 0.5)) = 15
      await service.reportProgress(member, 'title-1', 14);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      const result = await service.reportProgress(member, 'title-1', 15);
      expect(result.viewCounted).toBe(true);
    });

    it('rejects positions beyond the title duration', async () => {
      titles.findOne.mockResolvedValue(makeTitle({ durationSeconds: 7200 }));
      await expect(
        service.reportProgress(member, 'title-1', 7300),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(progress.upsert).not.toHaveBeenCalled();
    });

    it('404s for a member on an unpublished title', async () => {
      titles.findOne.mockResolvedValue(makeTitle({ publishedAt: null }));
      await expect(
        service.reportProgress(member, 'title-1', 90),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('saves progress but does not count a view for a moderator preview', async () => {
      // Moderators may report progress against an unpublished title (preview);
      // that must never inflate the public view count.
      titles.findOne.mockResolvedValue(makeTitle({ publishedAt: null }));
      const result = await service.reportProgress(moderator, 'title-1', 90);
      expect(progress.upsert).toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(result).toEqual({ positionSeconds: 90, viewCounted: false });
    });
  });

  describe('getTitle', () => {
    it('hides drafts from members', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({ status: TitleStatus.Draft, publishedAt: null }),
      );
      await expect(service.getTitle(member, 'title-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('shows drafts (with status fields) to moderators', async () => {
      titles.findOne.mockResolvedValue(
        makeTitle({
          status: TitleStatus.Failed,
          publishedAt: null,
          errorMessage: 'bad codec',
        }),
      );
      const detail = await service.getTitle(moderator, 'title-1');
      expect(detail.status).toBe(TitleStatus.Failed);
      expect(detail.errorMessage).toBe('bad codec');
    });

    it('omits admin fields for members', async () => {
      titles.findOne.mockResolvedValue(makeTitle());
      const detail = await service.getTitle(member, 'title-1');
      expect(detail.status).toBeUndefined();
      expect(detail.errorMessage).toBeUndefined();
    });
  });
});

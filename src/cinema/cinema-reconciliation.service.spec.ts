import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CinemaReconciliationService } from './cinema-reconciliation.service';
import { CinemaService } from './cinema.service';
import {
  CinemaTitle,
  TitleKind,
  TitleStatus,
} from './entities/cinema-title.entity';
import { MuxService } from './mux.service';

function makeTitle(overrides: Partial<CinemaTitle> = {}): CinemaTitle {
  return {
    id: 'title-1',
    kind: TitleKind.Film,
    title: 'My Film',
    description: null,
    coverImageUrl: null,
    status: TitleStatus.Processing,
    errorMessage: null,
    muxUploadId: 'up-1',
    muxAssetId: 'as-1',
    muxPlaybackId: null,
    pendingMuxUploadId: null,
    pendingMuxAssetId: null,
    lastIngestEventAt: new Date('2026-06-30T00:00:00Z'),
    durationSeconds: null,
    aspectRatio: null,
    publishedAt: null,
    viewCount: 0,
    createdBy: null,
    createdAt: new Date('2026-06-30T00:00:00Z'),
    updatedAt: new Date('2026-06-30T00:00:00Z'),
    ...overrides,
  };
}

describe('CinemaReconciliationService', () => {
  let service: CinemaReconciliationService;
  let titles: { find: jest.Mock; findOne: jest.Mock };
  let cinema: {
    onUploadAssetCreated: jest.Mock;
    onAssetReady: jest.Mock;
    onAssetErrored: jest.Mock;
    onUploadFailed: jest.Mock;
  };
  let mux: { getUpload: jest.Mock; getAsset: jest.Mock };
  let configValues: Record<string, string | undefined>;
  // The sweep is single-flighted across replicas by a Postgres advisory lock
  // (CNT-16) taken on a dedicated QueryRunner. `lockRunner.query` answers the
  // `pg_try_advisory_lock` probe; flip `isLockAvailable` to exercise the
  // "another replica is already sweeping" path.
  let isLockAvailable: boolean;
  let lockRunner: { connect: jest.Mock; query: jest.Mock; release: jest.Mock };

  beforeEach(async () => {
    isLockAvailable = true;
    lockRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn((sql: string) =>
        sql.includes('pg_try_advisory_lock')
          ? Promise.resolve([{ locked: isLockAvailable }])
          : Promise.resolve([{ pg_advisory_unlock: true }]),
      ),
      release: jest.fn().mockResolvedValue(undefined),
    };
    titles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    cinema = {
      onUploadAssetCreated: jest.fn(),
      onAssetReady: jest.fn(),
      onAssetErrored: jest.fn(),
      onUploadFailed: jest.fn(),
    };
    mux = { getUpload: jest.fn(), getAsset: jest.fn() };
    configValues = { 'mux.tokenId': 'token' };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CinemaReconciliationService,
        { provide: getRepositoryToken(CinemaTitle), useValue: titles },
        { provide: CinemaService, useValue: cinema },
        { provide: MuxService, useValue: mux },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => configValues[key]) },
        },
        {
          provide: DataSource,
          useValue: { createQueryRunner: jest.fn(() => lockRunner) },
        },
      ],
    }).compile();
    service = module.get(CinemaReconciliationService);
  });

  it('skips entirely when Mux is not configured', async () => {
    configValues = {};
    await service.reconcile();
    expect(titles.find).not.toHaveBeenCalled();
  });

  it('does not sweep when another replica holds the advisory lock', async () => {
    isLockAvailable = false;
    await service.reconcile();
    expect(titles.find).not.toHaveBeenCalled();
    // The runner is still returned to the pool, and no unlock is issued for a
    // lock this replica never took.
    expect(lockRunner.release).toHaveBeenCalled();
    expect(lockRunner.query).toHaveBeenCalledTimes(1);
  });

  it('releases the advisory lock and the runner after sweeping', async () => {
    await service.reconcile();
    expect(titles.find).toHaveBeenCalled();
    expect(lockRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
      expect.anything(),
    );
    expect(lockRunner.release).toHaveBeenCalled();
  });

  it('cuts stuck titles on last_ingest_event_at, not updated_at', async () => {
    // A view-count increment bumps updated_at; cutting on it would reset the
    // stale clock and hide a genuinely stuck title. The sweep must filter on
    // last_ingest_event_at instead.
    await service.reconcile();
    const where = (
      titles.find.mock.calls as [{ where?: Record<string, unknown>[] }][]
    )[0]![0].where;
    expect(Array.isArray(where)).toBe(true);
    for (const clause of where ?? []) {
      expect(clause).toHaveProperty('lastIngestEventAt');
      expect(clause).not.toHaveProperty('updatedAt');
    }
  });

  it('promotes a stuck upload whose asset now exists', async () => {
    titles.find.mockResolvedValue([
      makeTitle({ status: TitleStatus.AwaitingUpload, muxAssetId: null }),
    ]);
    mux.getUpload.mockResolvedValue({
      status: 'asset_created',
      assetId: 'as-9',
    });
    mux.getAsset.mockResolvedValue({
      status: 'preparing',
      playbackId: null,
      durationSeconds: null,
      aspectRatio: null,
      errorMessage: null,
    });
    await service.reconcile();
    expect(cinema.onUploadAssetCreated).toHaveBeenCalledWith('up-1', 'as-9');
  });

  it('fails a stuck upload that errored at Mux', async () => {
    titles.find.mockResolvedValue([
      makeTitle({ status: TitleStatus.AwaitingUpload, muxAssetId: null }),
    ]);
    mux.getUpload.mockResolvedValue({ status: 'errored', assetId: null });
    await service.reconcile();
    expect(cinema.onUploadFailed).toHaveBeenCalledWith(
      'up-1',
      'upload errored',
    );
    expect(mux.getAsset).not.toHaveBeenCalled();
  });

  it('readies a stuck processing title whose asset is ready', async () => {
    titles.find.mockResolvedValue([makeTitle()]);
    mux.getAsset.mockResolvedValue({
      status: 'ready',
      playbackId: 'pb-9',
      durationSeconds: 5400,
      aspectRatio: '16:9',
      errorMessage: null,
    });
    await service.reconcile();
    expect(cinema.onAssetReady).toHaveBeenCalledWith('as-1', {
      playbackId: 'pb-9',
      durationSeconds: 5400,
      aspectRatio: '16:9',
    });
  });

  it('fails a stuck processing title whose asset errored', async () => {
    titles.find.mockResolvedValue([makeTitle()]);
    mux.getAsset.mockResolvedValue({
      status: 'errored',
      playbackId: null,
      durationSeconds: null,
      aspectRatio: null,
      errorMessage: 'bad codec',
    });
    await service.reconcile();
    expect(cinema.onAssetErrored).toHaveBeenCalledWith('as-1', 'bad codec');
  });

  it('polls pending replacement assets on ready titles', async () => {
    titles.find.mockResolvedValue([
      makeTitle({
        status: TitleStatus.Ready,
        muxPlaybackId: 'pb-1',
        pendingMuxUploadId: 'up-2',
        pendingMuxAssetId: 'as-2',
      }),
    ]);
    mux.getAsset.mockResolvedValue({
      status: 'ready',
      playbackId: 'pb-2',
      durationSeconds: 6000,
      aspectRatio: '4:3',
      errorMessage: null,
    });
    await service.reconcile();
    expect(cinema.onAssetReady).toHaveBeenCalledWith('as-2', {
      playbackId: 'pb-2',
      durationSeconds: 6000,
      aspectRatio: '4:3',
    });
  });

  it('continues with the next title when one fails', async () => {
    titles.find.mockResolvedValue([
      makeTitle({ id: 'title-1' }),
      makeTitle({ id: 'title-2', muxAssetId: 'as-2' }),
    ]);
    mux.getAsset
      .mockRejectedValueOnce(new Error('mux down'))
      .mockResolvedValueOnce({
        status: 'ready',
        playbackId: 'pb-2',
        durationSeconds: 100,
        aspectRatio: null,
        errorMessage: null,
      });
    await service.reconcile();
    expect(cinema.onAssetReady).toHaveBeenCalledWith('as-2', {
      playbackId: 'pb-2',
      durationSeconds: 100,
      aspectRatio: null,
    });
  });

  describe('refreshTitle', () => {
    it('404s for an unknown title', async () => {
      titles.findOne.mockResolvedValue(null);
      await expect(service.refreshTitle('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refreshes state and returns the reloaded admin detail', async () => {
      const stale = makeTitle();
      const fresh = makeTitle({
        status: TitleStatus.Ready,
        muxPlaybackId: 'pb-9',
        durationSeconds: 5400,
      });
      titles.findOne.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
      mux.getAsset.mockResolvedValue({
        status: 'ready',
        playbackId: 'pb-9',
        durationSeconds: 5400,
        aspectRatio: '16:9',
        errorMessage: null,
      });
      const detail = await service.refreshTitle('title-1');
      expect(cinema.onAssetReady).toHaveBeenCalled();
      expect(detail.status).toBe(TitleStatus.Ready);
      expect(detail.durationSeconds).toBe(5400);
    });
  });
});

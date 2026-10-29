import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { MediaReferenceResolver } from '../media-references/media-reference.resolver';
import { Message } from '../messaging/entities/message.entity';
import { StorageMaintenanceService } from './storage-maintenance.service';
import { StorageService, StoredObject } from './storage.service';

const OLD = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(); // 30d
const RECENT = new Date(Date.now() - 1000 * 60).toISOString(); // 1m ago

function object(key: string, lastModified: string | null): StoredObject {
  return { key, size: 10, lastModified };
}

describe('StorageMaintenanceService.sweepOrphanedObjects', () => {
  let config: { get: jest.Mock };
  let storage: { listObjects: jest.Mock; deleteObjectByKey: jest.Mock };
  let resolver: { resolve: jest.Mock };
  let rawMany: jest.Mock;
  let messages: { createQueryBuilder: jest.Mock };
  let dataSource: { query: jest.Mock };
  let studioTrackRows: { audio_key: string }[];
  let service: StorageMaintenanceService;

  const envValues: Record<string, string> = {};

  beforeEach(() => {
    Object.keys(envValues).forEach((key) => delete envValues[key]);
    // Enabled + real deletion, so a test asserts actual deletes; individual
    // tests override.
    envValues.STORAGE_ORPHAN_SWEEP_ENABLED = 'true';
    envValues.STORAGE_ORPHAN_SWEEP_DRY_RUN = 'false';

    config = { get: jest.fn((key: string) => envValues[key]) };
    storage = {
      listObjects: jest
        .fn()
        .mockResolvedValue({ objects: [], nextContinuationToken: null }),
      deleteObjectByKey: jest.fn().mockResolvedValue(undefined),
    };
    resolver = {
      resolve: jest
        .fn()
        .mockResolvedValue({ references: new Map(), degraded: false }),
    };
    rawMany = jest.fn().mockResolvedValue([]);
    messages = {
      createQueryBuilder: jest.fn().mockReturnValue({
        withDeleted: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: rawMany,
      }),
    };
    studioTrackRows = [];
    dataSource = {
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql.trimStart().startsWith('SELECT') ? studioTrackRows : [],
        ),
      ),
    };
    service = new StorageMaintenanceService(
      config as unknown as ConfigService,
      storage as unknown as StorageService,
      resolver as unknown as MediaReferenceResolver,
      messages as unknown as Repository<Message>,
      dataSource as unknown as DataSource,
    );
  });

  it('does nothing when the sweep is disabled', async () => {
    envValues.STORAGE_ORPHAN_SWEEP_ENABLED = 'false';
    await service.sweepOrphanedObjects();
    expect(storage.listObjects).not.toHaveBeenCalled();
  });

  it('deletes an aged, unreferenced object', async () => {
    storage.listObjects.mockResolvedValue({
      objects: [object('avatars/u/f.jpg', OLD)],
      nextContinuationToken: null,
    });
    await service.sweepOrphanedObjects();
    expect(storage.deleteObjectByKey).toHaveBeenCalledWith('avatars/u/f.jpg');
  });

  it('never deletes an object still within the grace window', async () => {
    storage.listObjects.mockResolvedValue({
      objects: [object('avatars/u/f.jpg', RECENT)],
      nextContinuationToken: null,
    });
    await service.sweepOrphanedObjects();
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
  });

  it('never deletes an object with unknown age (null lastModified)', async () => {
    storage.listObjects.mockResolvedValue({
      objects: [object('avatars/u/f.jpg', null)],
      nextContinuationToken: null,
    });
    await service.sweepOrphanedObjects();
    expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
  });

  it('never deletes a key referenced by an image column', async () => {
    storage.listObjects.mockResolvedValue({
      objects: [object('avatars/u/f.jpg', OLD)],
      nextContinuationToken: null,
    });
    resolver.resolve.mockResolvedValue({
      references: new Map([['avatars/u/f.jpg', [{ type: 'profile-photo' }]]]),
      degraded: false,
    });
    await service.sweepOrphanedObjects();
    expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
  });

  it('never deletes a message-image key still referenced by a message (no resolver source)', async () => {
    storage.listObjects.mockResolvedValue({
      objects: [object('message-images/u/f.jpg', OLD)],
      nextContinuationToken: null,
    });
    // Resolver has no message source, so it reports the key as unreferenced...
    resolver.resolve.mockResolvedValue({
      references: new Map(),
      degraded: false,
    });
    // ...but a message attachment references it (stored as the bare key).
    rawMany.mockResolvedValue([{ url: 'message-images/u/f.jpg' }]);
    await service.sweepOrphanedObjects();
    expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
  });

  it('deletes nothing from a degraded batch (incomplete reference set)', async () => {
    storage.listObjects.mockResolvedValue({
      objects: [object('avatars/u/f.jpg', OLD)],
      nextContinuationToken: null,
    });
    resolver.resolve.mockResolvedValue({
      references: new Map(),
      degraded: true,
    });
    await service.sweepOrphanedObjects();
    expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
  });

  it('logs but does not delete in dry-run (the default when enabled)', async () => {
    envValues.STORAGE_ORPHAN_SWEEP_DRY_RUN = 'true';
    storage.listObjects.mockResolvedValue({
      objects: [object('avatars/u/f.jpg', OLD)],
      nextContinuationToken: null,
    });
    await service.sweepOrphanedObjects();
    expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
  });

  it('swallows errors so a failing tick never crashes the scheduler', async () => {
    storage.listObjects.mockRejectedValue(new Error('bucket down'));
    await expect(service.sweepOrphanedObjects()).resolves.toBeUndefined();
  });

  describe('Studio audio', () => {
    const STUDIO_KEY =
      'studio-audio/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.mp3';

    it('keeps a Studio audio object a track still holds', async () => {
      storage.listObjects.mockResolvedValue({
        objects: [object(STUDIO_KEY, OLD)],
        nextContinuationToken: null,
      });
      studioTrackRows = [{ audio_key: STUDIO_KEY }];

      await service.sweepOrphanedObjects();

      expect(dataSource.query).toHaveBeenCalledWith(
        `SELECT "audio_key" FROM "studio_tracks" WHERE "audio_key" = ANY($1) UNION SELECT "source_audio_key" AS "audio_key" FROM "studio_kept_tracks" WHERE "source_audio_key" = ANY($1) AND "copy_attempts" < 10`,
        [[STUDIO_KEY]],
      );
      expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
    });

    it('keeps a Studio audio source a kept track still waits to copy', async () => {
      const pendingSourceKey =
        'studio-audio/11111111-2222-4333-8444-555555555555/88888888-7777-4888-9999-000000000000.mp3';
      storage.listObjects.mockResolvedValue({
        objects: [object(pendingSourceKey, OLD), object(STUDIO_KEY, OLD)],
        nextContinuationToken: null,
      });
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('"source_audio_key" = ANY($1)')) {
          return Promise.resolve([{ audio_key: pendingSourceKey }]);
        }
        return Promise.resolve([]);
      });

      await service.sweepOrphanedObjects();

      expect(storage.deleteObjectByKey.mock.calls).toEqual([[STUDIO_KEY]]);
    });

    it('stops counting a kept source once its copy used all ten tries', async () => {
      storage.listObjects.mockResolvedValue({
        objects: [object(STUDIO_KEY, OLD)],
        nextContinuationToken: null,
      });

      await service.sweepOrphanedObjects();

      const keptSourceStatements = dataSource.query.mock.calls
        .map(([sql]) => String(sql))
        .filter((sql) => sql.includes('"source_audio_key" = ANY($1)'));
      expect(
        keptSourceStatements.map((sql) =>
          sql.endsWith('AND "copy_attempts" < 10'),
        ),
      ).toEqual([true]);
    });

    it('deletes an unreferenced Studio audio object and forgets its registry row', async () => {
      storage.listObjects.mockResolvedValue({
        objects: [object(STUDIO_KEY, OLD)],
        nextContinuationToken: null,
      });

      await service.sweepOrphanedObjects();

      expect(storage.deleteObjectByKey).toHaveBeenCalledWith(STUDIO_KEY);
      expect(dataSource.query).toHaveBeenCalledWith(
        `DELETE FROM "studio_audio_uploads" WHERE "storage_key" = $1`,
        [STUDIO_KEY],
      );
    });

    it('keeps a kept copy a kept track references and reclaims one nothing references', async () => {
      const keptKey =
        'studio-kept-audio/66666666-7777-4888-9999-000000000000.mp3';
      const orphanKeptKey =
        'studio-kept-audio/77777777-7777-4888-9999-000000000000.m4a';
      storage.listObjects.mockResolvedValue({
        objects: [object(keptKey, OLD), object(orphanKeptKey, OLD)],
        nextContinuationToken: null,
      });
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('"studio_kept_tracks"')) {
          return Promise.resolve([{ audio_key: keptKey }]);
        }
        return Promise.resolve([]);
      });

      await service.sweepOrphanedObjects();

      expect(dataSource.query).toHaveBeenCalledWith(
        `SELECT "audio_key" FROM "studio_kept_tracks" WHERE "audio_key" = ANY($1)`,
        [[keptKey, orphanKeptKey]],
      );
      expect(storage.deleteObjectByKey.mock.calls).toEqual([[orphanKeptKey]]);
    });

    it('asks the tracks table nothing when a batch holds no Studio audio', async () => {
      storage.listObjects.mockResolvedValue({
        objects: [object('avatars/u/f.jpg', OLD)],
        nextContinuationToken: null,
      });

      await service.sweepOrphanedObjects();

      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  describe('Studio landing photos', () => {
    const LIVE_PHOTO_KEY =
      'studio-landing/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.jpg';
    const REPLACED_PHOTO_KEY =
      'studio-landing/11111111-2222-4333-8444-555555555555/88888888-7777-4888-9999-000000000000.jpg';

    it('keeps a landing photo a row stores and reclaims a replaced copy', async () => {
      storage.listObjects.mockResolvedValue({
        objects: [
          object(LIVE_PHOTO_KEY, OLD),
          object(REPLACED_PHOTO_KEY, OLD),
          object('avatars/u/f.jpg', OLD),
        ],
        nextContinuationToken: null,
      });
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('"studio_landing_photos"')) {
          return Promise.resolve([{ image_key: LIVE_PHOTO_KEY }]);
        }
        return Promise.resolve([]);
      });

      await service.sweepOrphanedObjects();

      expect(dataSource.query).toHaveBeenCalledWith(
        `SELECT "image_key" FROM "studio_landing_photos" WHERE "image_key" = ANY($1)`,
        [[LIVE_PHOTO_KEY, REPLACED_PHOTO_KEY]],
      );
      expect(storage.deleteObjectByKey.mock.calls).toEqual([
        [REPLACED_PHOTO_KEY],
        ['avatars/u/f.jpg'],
      ]);
    });
  });
});

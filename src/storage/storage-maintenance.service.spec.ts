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
        `SELECT "audio_key" FROM "studio_tracks" WHERE "audio_key" = ANY($1)`,
        [[STUDIO_KEY]],
      );
      expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
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

    it('asks the tracks table nothing when a batch holds no Studio audio', async () => {
      storage.listObjects.mockResolvedValue({
        objects: [object('avatars/u/f.jpg', OLD)],
        nextContinuationToken: null,
      });

      await service.sweepOrphanedObjects();

      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });
});

import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
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
    service = new StorageMaintenanceService(
      config as unknown as ConfigService,
      storage as unknown as StorageService,
      resolver as unknown as MediaReferenceResolver,
      messages as unknown as Repository<Message>,
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
});

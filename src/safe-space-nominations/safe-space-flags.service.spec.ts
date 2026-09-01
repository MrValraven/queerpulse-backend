import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { Listing, SafeSpaceStatus } from '../listings/entities/listing.entity';
import { CreateSafeSpaceFlagDto } from './dto/safe-space-flag.dto';
import { SafeSpaceFlag } from './entities/safe-space-flag.entity';
import { SafeSpaceAuditService } from './safe-space-audit.service';
import { SafeSpaceBadgeService } from './safe-space-badge.service';
import { SafeSpaceFlagsService } from './safe-space-flags.service';
import { SafeSpaceNotifierService } from './safe-space-notifier.service';

const now = new Date('2026-08-20T12:00:00.000Z');

const verifiedListing = {
  id: 'listing-1',
  slug: 'casa-aberta',
  ownerId: 'owner-1',
  safeSpaceStatus: SafeSpaceStatus.Verified,
} as Listing;

describe('SafeSpaceFlagsService', () => {
  let service: SafeSpaceFlagsService;
  let flags: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let badges: {
    resolvePublicSpaceBySlug: jest.Mock;
    openFlagsForListing: jest.Mock;
    suspendForFlagThreshold: jest.Mock;
  };
  let adminQueueNotifications: { announce: jest.Mock };

  const dto: CreateSafeSpaceFlagDto = { reasonCode: 'not_safe' };

  beforeEach(async () => {
    flags = {
      create: jest.fn((v: Partial<SafeSpaceFlag>) => v),
      save: jest.fn((v: Partial<SafeSpaceFlag>) =>
        Promise.resolve({
          id: 'flag-1',
          createdAt: now,
          resolvedAt: null,
          resolution: null,
          ...v,
        } as SafeSpaceFlag),
      ),
      findOne: jest.fn().mockResolvedValue(null),
    };
    badges = {
      resolvePublicSpaceBySlug: jest.fn().mockResolvedValue(verifiedListing),
      openFlagsForListing: jest.fn().mockResolvedValue([{ flaggerId: 'u1' }]),
      suspendForFlagThreshold: jest.fn(),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SafeSpaceFlagsService,
        { provide: getRepositoryToken(SafeSpaceFlag), useValue: flags },
        { provide: getRepositoryToken(Listing), useValue: {} },
        { provide: SafeSpaceBadgeService, useValue: badges },
        { provide: SafeSpaceAuditService, useValue: { record: jest.fn() } },
        { provide: SafeSpaceNotifierService, useValue: { tell: jest.fn() } },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();
    service = module.get(SafeSpaceFlagsService);
  });

  describe('flag', () => {
    it('tells the flag queue on a new flag, with the saved row id', async () => {
      const result = await service.flag('u1', 'casa-aberta', dto);

      expect(result.id).toBe('flag-1');
      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.SafeSpaceFlags,
        'flag-1',
      );
    });

    it('announces a flag on the queue that excludes directory moderators', async () => {
      await service.flag('u1', 'casa-aberta', dto);

      // Not `SafeSpaceNominations`. The flag queue is the only surface serving
      // a flagger's identity and free text, so it is deliberately closed to
      // the `directory_moderator` grant that opens the rest of
      // /admin/safe-spaces.
      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.SafeSpaceFlags,
        expect.any(String),
      );
    });

    it('tells nobody on the idempotent repeat of an already-open flag', async () => {
      flags.findOne.mockResolvedValue({
        id: 'flag-existing',
        listingId: 'listing-1',
        flaggerId: 'u1',
        createdAt: now,
        resolvedAt: null,
        resolution: null,
      });

      const result = await service.flag('u1', 'casa-aberta', dto);

      expect(result.wasAlreadyFlagged).toBe(true);
      expect(flags.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });
  });
});

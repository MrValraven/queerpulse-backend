import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { Listing } from '../listings/entities/listing.entity';
import { SafeSpaceVisitsService } from '../safe-space-vouches/safe-space-visits.service';
import { CreateSafeSpaceNominationDto } from './dto/create-safe-space-nomination.dto';
import { SafeSpaceNomination } from './entities/safe-space-nomination.entity';
import { SafeSpaceAuditService } from './safe-space-audit.service';
import { SafeSpaceBadgeService } from './safe-space-badge.service';
import { SafeSpaceNominationsService } from './safe-space-nominations.service';
import { SafeSpaceNotifierService } from './safe-space-notifier.service';

const now = new Date('2026-08-20T12:00:00.000Z');

describe('SafeSpaceNominationsService', () => {
  let service: SafeSpaceNominationsService;
  let nominations: { create: jest.Mock; save: jest.Mock };
  let adminQueueNotifications: { announce: jest.Mock };

  beforeEach(async () => {
    nominations = {
      create: jest.fn((v: Partial<SafeSpaceNomination>) => v),
      save: jest.fn((v: Partial<SafeSpaceNomination>) =>
        Promise.resolve({
          id: 'nomination-1',
          createdAt: now,
          acknowledgedAt: null,
          decidedAt: null,
          decisionReason: null,
          awardedTier: null,
          ...v,
        } as SafeSpaceNomination),
      ),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SafeSpaceNominationsService,
        {
          provide: getRepositoryToken(SafeSpaceNomination),
          useValue: nominations,
        },
        { provide: getRepositoryToken(Listing), useValue: {} },
        { provide: SafeSpaceVisitsService, useValue: {} },
        { provide: SafeSpaceBadgeService, useValue: {} },
        { provide: SafeSpaceAuditService, useValue: { record: jest.fn() } },
        { provide: SafeSpaceNotifierService, useValue: { tell: jest.fn() } },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();
    service = module.get(SafeSpaceNominationsService);
  });

  describe('create', () => {
    const dto: CreateSafeSpaceNominationDto = {
      placeName: 'Casa Aberta',
    };

    it('tells the safe-space nomination queue with the saved row id', async () => {
      const result = await service.create('nominator-1', dto);

      expect(result.id).toBe('nomination-1');
      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.SafeSpaceNominations,
        'nomination-1',
      );
    });

    it('tells nobody when the nomination is never saved', async () => {
      nominations.save.mockRejectedValue(new Error('write failed'));

      await expect(service.create('nominator-1', dto)).rejects.toThrow(
        'write failed',
      );
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { CommissionInterestsService } from './commission-interests.service';
import { CreateCommissionInterestDto } from './dto/create-commission-interest.dto';
import {
  CommissionCategory,
  CommissionInterest,
} from './entities/commission-interest.entity';

const now = new Date('2026-07-15T12:00:00.000Z');

describe('CommissionInterestsService', () => {
  let service: CommissionInterestsService;
  let repo: { create: jest.Mock; save: jest.Mock };
  let adminQueueNotifications: { announce: jest.Mock };

  beforeEach(async () => {
    repo = {
      create: jest.fn((v: Partial<CommissionInterest>) => v),
      save: jest.fn((v: Partial<CommissionInterest>) =>
        Promise.resolve({
          id: 'ci-1',
          createdAt: now,
          ...v,
        } as CommissionInterest),
      ),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommissionInterestsService,
        { provide: getRepositoryToken(CommissionInterest), useValue: repo },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();
    service = module.get(CommissionInterestsService);
  });

  describe('create', () => {
    const dto: CreateCommissionInterestDto = {
      commissionTitle: 'Portraits of Queer Elders in Mouraria',
      commissionCategory: CommissionCategory.Photo,
      recipientName: 'Inês Tavares',
      message: '  I would love to help with the captions.  ',
    };

    it('scopes the interest to the calling member and trims the message', async () => {
      const result = await service.create('u1', dto);

      expect(repo.create).toHaveBeenCalledWith({
        memberId: 'u1',
        commissionTitle: dto.commissionTitle,
        commissionCategory: dto.commissionCategory,
        recipientName: dto.recipientName,
        message: 'I would love to help with the captions.',
      });
      expect(result).toEqual({
        id: 'ci-1',
        commissionTitle: dto.commissionTitle,
        commissionCategory: dto.commissionCategory,
        recipientName: dto.recipientName,
        message: 'I would love to help with the captions.',
        createdAt: now.toISOString(),
      });
    });

    it('stores a null message when the optional textarea was left empty', async () => {
      const result = await service.create('u1', { ...dto, message: '   ' });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ message: null }),
      );
      expect(result.message).toBeNull();
    });

    it('stores a null message when it was omitted entirely', async () => {
      const withoutMessage: CreateCommissionInterestDto = { ...dto };
      delete withoutMessage.message;
      const result = await service.create('u1', withoutMessage);

      expect(result.message).toBeNull();
    });

    it('tells the commission-interest queue with the saved row id', async () => {
      await service.create('u1', dto);

      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.CommissionInterests,
        'ci-1',
      );
    });

    it('tells nobody when the interest is never saved', async () => {
      repo.save.mockRejectedValueOnce(new Error('write failed'));

      await expect(service.create('u1', dto)).rejects.toThrow('write failed');
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });
  });
});

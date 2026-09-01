import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { Profile } from '../users/entities/profile.entity';
import { ChangemakerNomination } from './entities/changemaker-nomination.entity';
import { CreateChangemakerNominationDto } from './dto/create-changemaker-nomination.dto';
import { ChangemakerNominationsService } from './changemaker-nominations.service';

const now = new Date('2026-07-15T12:00:00.000Z');

describe('ChangemakerNominationsService', () => {
  let service: ChangemakerNominationsService;
  let repo: { create: jest.Mock; save: jest.Mock };
  /** Rows `MemberLookup.userIdsForSlugs` finds for this test. */
  let activeProfiles: { slug: string; userId: string }[];
  let adminQueueNotifications: { announce: jest.Mock };

  beforeEach(async () => {
    repo = {
      create: jest.fn((v: Partial<ChangemakerNomination>) => v),
      save: jest.fn((v: Partial<ChangemakerNomination>) =>
        Promise.resolve({
          id: 'cn-1',
          createdAt: now,
          ...v,
        } as ChangemakerNomination),
      ),
    };
    activeProfiles = [];
    // `MemberLookup` resolves slugs through a query builder joined to active
    // users; the mock stands in for that whole chain.
    const queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn(() => Promise.resolve(activeProfiles)),
    };
    const profiles = { createQueryBuilder: jest.fn(() => queryBuilder) };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChangemakerNominationsService,
        { provide: getRepositoryToken(ChangemakerNomination), useValue: repo },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();
    service = module.get(ChangemakerNominationsService);
  });

  describe('create', () => {
    const dto: CreateChangemakerNominationDto = {
      nomineeName: '  Inês Tavares  ',
      reason: '  Always shows up for people.  ',
    };

    it('scopes the nomination to the calling nominator and trims the name', async () => {
      const result = await service.create('u1', dto);

      expect(repo.create).toHaveBeenCalledWith({
        nominatorId: 'u1',
        nomineeName: 'Inês Tavares',
        reason: 'Always shows up for people.',
        nomineeUserId: null,
        nomineeContact: null,
      });
      expect(result).toEqual({
        id: 'cn-1',
        nomineeName: 'Inês Tavares',
        reason: 'Always shows up for people.',
        createdAt: now.toISOString(),
      });
    });

    it('resolves a picked member slug to the stored nominee user id', async () => {
      activeProfiles = [{ slug: 'ines-tavares', userId: 'u2' }];

      await service.create('u1', { ...dto, nomineeSlug: ' ines-tavares ' });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ nomineeUserId: 'u2' }),
      );
    });

    it('rejects a slug that no longer points at an active member', async () => {
      activeProfiles = [];

      await expect(
        service.create('u1', { ...dto, nomineeSlug: 'gone' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects nominating yourself', async () => {
      activeProfiles = [{ slug: 'me', userId: 'u1' }];

      await expect(
        service.create('u1', { ...dto, nomineeSlug: 'me' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('trims the contact field and stores whitespace-only as null', async () => {
      await service.create('u1', {
        ...dto,
        nomineeContact: '  instagram.com/ines  ',
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ nomineeContact: 'instagram.com/ines' }),
      );

      await service.create('u1', { ...dto, nomineeContact: '   ' });
      expect(repo.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ nomineeContact: null }),
      );
    });

    it('tells the changemaker-nomination queue with the saved row id', async () => {
      await service.create('u1', dto);

      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.ChangemakerNominations,
        'cn-1',
      );
    });

    it('tells nobody when the nomination is never saved', async () => {
      repo.save.mockRejectedValueOnce(new Error('write failed'));

      await expect(service.create('u1', dto)).rejects.toThrow('write failed');
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });
  });
});

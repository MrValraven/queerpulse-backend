import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { UserStatus } from '../users/entities/user.entity';
import { Profile } from '../users/entities/profile.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { IntakeSubmission } from './entities/intake-submission.entity';
import { IntakesService } from './intakes.service';

describe('IntakesService', () => {
  let service: IntakesService;
  let submissions: {
    save: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: { find: jest.Mock };
  let notifications: { create: jest.Mock };
  let adminQueueNotifications: { announce: jest.Mock };

  const activeMember = (
    overrides: Partial<CurrentUserData> = {},
  ): CurrentUserData => ({
    userId: 'member-1',
    email: 'sam@example.com',
    status: UserStatus.Active,
    role: 'member',
    ...overrides,
  });

  beforeEach(async () => {
    submissions = {
      // Real TypeORM assigns the uuid PK on `create`/`save`; the mock does
      // the same so the announce-routing tests can assert against a real,
      // defined id.
      save: jest
        .fn()
        .mockImplementation((row: Partial<IntakeSubmission>) =>
          Promise.resolve({ id: 'submission-1', ...row }),
        ),
      create: jest.fn((value: object) => value),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    notifications = { create: jest.fn().mockResolvedValue(null) };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntakesService,
        {
          provide: getRepositoryToken(IntakeSubmission),
          useValue: submissions,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();

    service = module.get(IntakesService);
  });

  describe('submit', () => {
    it('rejects an unknown kind before writing anything', async () => {
      await expect(
        service.submit('not_a_real_kind', { note: 'hi' }, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(submissions.save).not.toHaveBeenCalled();
    });

    it('requires an active member for a member-only kind', async () => {
      await expect(
        service.submit('incubator_mentor', { note: 'hi' }, undefined),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(submissions.save).not.toHaveBeenCalled();
    });

    it('accepts an anonymous submission on a public kind', async () => {
      const ack = await service.submit(
        'sober_host',
        { note: 'my place' },
        undefined,
      );
      expect(ack.id).toBe('submission-1');
      expect(submissions.create).toHaveBeenCalledWith(
        expect.objectContaining({ submitterId: null, kind: 'sober_host' }),
      );
    });

    // The routing this task adds: a governance concern reaches its own
    // console and its own reviewers; every other kind reaches /admin/intakes.
    it('routes a governance_concern submission to the Concerns queue', async () => {
      await service.submit(
        'governance_concern',
        { category: 'community_safety' },
        activeMember(),
      );

      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.Concerns,
        'submission-1',
      );
    });

    it('routes every other kind to the Intakes queue', async () => {
      await service.submit('grant', { amount: 500 }, undefined);

      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.Intakes,
        'submission-1',
      );
    });

    it('tells nobody when the submission is refused', async () => {
      await expect(
        service.submit('incubator_mentor', { note: 'hi' }, undefined),
      ).rejects.toThrow();

      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });
  });
});

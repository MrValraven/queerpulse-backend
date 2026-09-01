import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AccountEnforcementService } from './account-enforcement.service';
import { ModAuditService } from './mod-audit.service';
import { ReportSubjectResolverService } from './report-subject-resolver.service';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { NotificationsService } from '../notifications/notifications.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  BanRatification,
  BanRatificationStatus,
} from './entities/ban-ratification.entity';

// TS-12's ban-ratification hold, and (new) whoever the admin-queue-notifications
// task wires into its arrival: `restrictMember` is the direct admin entry point
// into `openBanHold`, and it needs none of `enforceAgainstUser`'s report/subject
// resolution machinery, so it is the narrower surface to exercise this against.
describe('AccountEnforcementService', () => {
  let service: AccountEnforcementService;
  let users: { findOne: jest.Mock };
  let profiles: { findOne: jest.Mock };
  let banRatifications: {
    findOne: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  let writeAuditLog: jest.Mock;
  let adminQueueNotifications: { announce: jest.Mock };
  let manager: {
    update: jest.Mock;
    findOne: jest.Mock;
    getRepository: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };

  const PROPOSING_MODERATOR_ID = 'mod-1';
  const TARGET_MEMBER_ID = 'member-1';

  const newHoldRow = (overrides: Partial<BanRatification> = {}) =>
    ({
      id: 'hold-1',
      targetUserId: TARGET_MEMBER_ID,
      status: BanRatificationStatus.Pending,
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      ...overrides,
    }) as BanRatification;

  beforeEach(async () => {
    users = {
      findOne: jest.fn().mockResolvedValue({
        id: TARGET_MEMBER_ID,
        role: UserRole.Member,
        isSystem: false,
        status: UserStatus.Active,
      }),
    };
    profiles = { findOne: jest.fn().mockResolvedValue(null) };
    // No hold stands yet by default, so a `ban` opens a fresh one.
    banRatifications = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      create: jest.fn((value: object) => value),
      save: jest.fn((value: object) =>
        Promise.resolve(newHoldRow(value as Partial<BanRatification>)),
      ),
    };
    writeAuditLog = jest.fn().mockResolvedValue(undefined);
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    manager = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest
        .fn()
        .mockImplementation((entity: unknown, opts: unknown) => {
          if (entity === Profile)
            return profiles.findOne(opts) as Promise<unknown>;
          return users.findOne(opts) as Promise<unknown>;
        }),
      getRepository: jest.fn(() => banRatifications),
    };
    dataSource = {
      transaction: jest.fn((callback: (m: unknown) => unknown) =>
        callback(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountEnforcementService,
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        {
          provide: getRepositoryToken(BanRatification),
          useValue: banRatifications,
        },
        { provide: DataSource, useValue: dataSource },
        { provide: ModAuditService, useValue: { writeAuditLog } },
        {
          provide: ReportSubjectResolverService,
          useValue: { resolve: jest.fn() },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();
    service = module.get(AccountEnforcementService);
  });

  describe('restrictMember: ban-ratification queue arrival', () => {
    it('tells the ban-ratifications queue when a permanent ban opens a new hold', async () => {
      await service.restrictMember(TARGET_MEMBER_ID, PROPOSING_MODERATOR_ID, {
        action: 'ban',
        reasonCode: 'harassment',
        note: 'Repeat targeted harassment across several threads.',
      });

      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.BanRatifications,
        'hold-1',
        [PROPOSING_MODERATOR_ID],
      );
    });

    // The test above only proves `announce` is CALLED with the proposing
    // moderator's id as the third argument; `adminQueueNotifications` there is
    // a bare mock, so nothing checks that the argument does anything. This
    // test wires in the REAL `AdminQueueNotificationsService` (its own
    // dependencies stubbed) against a `ban_ratifications` recipient pool that
    // contains the proposing moderator as a genuine candidate: the queue's
    // tier is plain `Moderator`, no extra capability, so the assertion only
    // passes if the exclusion actually removes them from the final recipient
    // list `NotificationsService.createForRecipients` receives.
    it('actually removes the proposing moderator from the recipients the real announce service would otherwise notify', async () => {
      const OTHER_MODERATOR_ID = 'mod-2';
      const usersForQueue = {
        // Reuses the same `findOne` the transaction's `manager.findOne` calls
        // for the target member lookup, plus the tier-population `find` the
        // real `AdminQueueNotificationsService.resolveRecipients` runs,
        // returning BOTH moderators as active, so the exclusion is the only
        // thing standing between the proposing moderator and a notification.
        findOne: users.findOne,
        find: jest
          .fn()
          .mockResolvedValue([
            { id: PROPOSING_MODERATOR_ID },
            { id: OTHER_MODERATOR_ID },
          ]),
      };
      const createForRecipients = jest.fn().mockResolvedValue(undefined);

      const moduleWithRealAnnounce: TestingModule =
        await Test.createTestingModule({
          providers: [
            AccountEnforcementService,
            { provide: getRepositoryToken(User), useValue: usersForQueue },
            { provide: getRepositoryToken(Profile), useValue: profiles },
            {
              provide: getRepositoryToken(BanRatification),
              useValue: banRatifications,
            },
            { provide: DataSource, useValue: dataSource },
            { provide: ModAuditService, useValue: { writeAuditLog } },
            {
              provide: ReportSubjectResolverService,
              useValue: { resolve: jest.fn() },
            },
            { provide: EventEmitter2, useValue: { emit: jest.fn() } },
            AdminQueueNotificationsService,
            {
              provide: getRepositoryToken(UserStaffRole),
              useValue: { find: jest.fn().mockResolvedValue([]) },
            },
            {
              provide: NotificationsService,
              useValue: { createForRecipients },
            },
          ],
        }).compile();
      const serviceWithRealAnnounce = moduleWithRealAnnounce.get(
        AccountEnforcementService,
      );

      await serviceWithRealAnnounce.restrictMember(
        TARGET_MEMBER_ID,
        PROPOSING_MODERATOR_ID,
        {
          action: 'ban',
          reasonCode: 'harassment',
          note: 'Repeat targeted harassment across several threads.',
        },
      );

      expect(createForRecipients).toHaveBeenCalledTimes(1);
      const [notifiedUserIds] = createForRecipients.mock.calls[0] as [string[]];
      expect(notifiedUserIds).toContain(OTHER_MODERATOR_ID);
      expect(notifiedUserIds).not.toContain(PROPOSING_MODERATOR_ID);
    });

    it('does not announce again when the ban joins an already-pending hold', async () => {
      // `openBanHold` is idempotent per member: a second restrict against a
      // member who already has a live hold JOINS it rather than opening a
      // second one, and a repeat notification about the same pending row
      // would tell staff nothing new.
      banRatifications.findOne.mockResolvedValue(
        newHoldRow({ id: 'hold-existing' }),
      );

      await service.restrictMember(TARGET_MEMBER_ID, PROPOSING_MODERATOR_ID, {
        action: 'ban',
        reasonCode: 'harassment',
        note: 'Repeat targeted harassment across several threads.',
      });

      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    it('tells nobody when the restriction is refused', async () => {
      users.findOne.mockResolvedValue(null);

      await expect(
        service.restrictMember(TARGET_MEMBER_ID, PROPOSING_MODERATOR_ID, {
          action: 'ban',
          reasonCode: 'harassment',
          note: 'Repeat targeted harassment across several threads.',
        }),
      ).rejects.toThrow();

      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });
  });
});

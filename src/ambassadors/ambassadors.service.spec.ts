import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { IsNull, Repository } from 'typeorm';
import { CommunitySystemMembershipService } from '../communities/community-system-membership.service';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { AmbassadorCircleService } from './ambassador-circle.service';
import { AmbassadorsService } from './ambassadors.service';
import { Ambassador } from './entities/ambassador.entity';

/**
 * The grant lifecycle. Beyond the coded refusals, these pin the two roster
 * guarantees the circle depends on: a revoke only ever takes out a plain
 * `member` row, so a staff moderator who is also an ambassador keeps their
 * seat (Review Focus 1), and a re-grant after a revoke writes a fresh row and
 * seats the member again (Review Focus 3).
 */

const circle = {
  id: 'circle-1',
  slug: 'queerpulse-ambassadors',
} as Community;

const memberProfile = {
  userId: 'member-1',
  slug: 'rui',
  firstName: 'Rui',
  lastName: 'Costa',
  avatarUrl: null,
  photoVisible: true,
  isAmbassadorTagVisible: true,
} as unknown as Profile;

const staffProfile = {
  userId: 'staff-1',
  slug: 'ana',
  firstName: 'Ana',
  lastName: 'Silva',
} as unknown as Profile;

function buildGrantRow(overrides: Partial<Ambassador> = {}): Ambassador {
  return {
    id: 'grant-1',
    userId: 'member-1',
    focusArea: 'housing',
    grantedById: 'staff-1',
    grantedAt: new Date('2026-09-01T10:00:00Z'),
    grantReason: 'Runs the housing help desk',
    revokedAt: null,
    revokedById: null,
    revokeReason: null,
    user: {
      id: 'member-1',
      inviteMonthlyQuota: null,
      profile: memberProfile,
    } as unknown as User,
    ...overrides,
  };
}

/** Awaits a rejection and checks both the exception class and its `code`. */
async function expectCodedError(
  pending: Promise<unknown>,
  expectedClass: new (...args: never[]) => HttpException,
  code: string,
): Promise<void> {
  const caught: unknown = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(expectedClass);
  expect((caught as HttpException).getResponse()).toMatchObject({ code });
}

const grantInput = {
  memberSlug: 'rui',
  focusArea: 'housing' as const,
  reason: 'Runs the housing help desk',
};

describe('AmbassadorsService', () => {
  function buildService(
    options: {
      profileBySlug?: Partial<Profile> | null;
      user?: Partial<User> | null;
      hasActiveGrant?: boolean;
      saveError?: unknown;
      activeRowForRevoke?: Partial<Ambassador> | null;
      updateAffected?: number;
      addMemberError?: Error;
      notificationError?: Error;
    } = {},
  ) {
    const ambassadorsRepository = {
      exists: jest.fn().mockResolvedValue(options.hasActiveGrant ?? false),
      create: jest.fn((values: Partial<Ambassador>) => values),
      save: options.saveError
        ? jest.fn().mockRejectedValue(options.saveError)
        : jest.fn((values: Partial<Ambassador>) =>
            Promise.resolve({ ...values, id: 'grant-new' }),
          ),
      delete: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
      update: jest
        .fn()
        .mockResolvedValue({ affected: options.updateAffected ?? 1 }),
      // The revoke pre-check reads with `select`; the post-write reload
      // reads with `relations`.
      findOne: jest.fn((findOptions: { select?: unknown }) =>
        Promise.resolve(
          findOptions.select
            ? options.activeRowForRevoke === undefined
              ? { id: 'grant-1', userId: 'member-1' }
              : options.activeRowForRevoke
            : buildGrantRow(),
        ),
      ),
      find: jest.fn().mockResolvedValue([buildGrantRow()]),
      findAndCount: jest.fn().mockResolvedValue([[buildGrantRow()], 1]),
    };
    const profilesRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue(
          options.profileBySlug === undefined
            ? { userId: 'member-1' }
            : options.profileBySlug,
        ),
      find: jest.fn().mockResolvedValue([staffProfile]),
    };
    const usersRepository = {
      findOne: jest.fn().mockResolvedValue(
        options.user === undefined
          ? {
              id: 'member-1',
              isSystem: false,
              status: UserStatus.Active,
            }
          : options.user,
      ),
    };
    const communityMembersRepository = {
      count: jest.fn().mockResolvedValue(4),
      exists: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const staffRolesRepository = {
      exists: jest.fn().mockResolvedValue(false),
    };
    const circleService = {
      resolveCircle: jest.fn().mockResolvedValue(circle),
      findCircle: jest.fn().mockResolvedValue(circle),
    };
    const systemMembership = {
      addMember: options.addMemberError
        ? jest.fn().mockRejectedValue(options.addMemberError)
        : jest.fn().mockResolvedValue(true),
      removeMemberIfRole: jest.fn().mockResolvedValue(true),
    };
    const notifications = {
      create: options.notificationError
        ? jest.fn().mockRejectedValue(options.notificationError)
        : jest.fn().mockResolvedValue(null),
    };
    const service = new AmbassadorsService(
      ambassadorsRepository as unknown as Repository<Ambassador>,
      profilesRepository as unknown as Repository<Profile>,
      usersRepository as unknown as Repository<User>,
      communityMembersRepository as unknown as Repository<CommunityMember>,
      staffRolesRepository as unknown as Repository<UserStaffRole>,
      circleService as unknown as AmbassadorCircleService,
      systemMembership as unknown as CommunitySystemMembershipService,
      notifications as unknown as NotificationsService,
    );
    return {
      service,
      ambassadorsRepository,
      profilesRepository,
      usersRepository,
      communityMembersRepository,
      staffRolesRepository,
      circleService,
      systemMembership,
      notifications,
    };
  }

  describe('grant', () => {
    it('inserts a row, joins the circle as member and notifies with the focus area and circle slug', async () => {
      const {
        service,
        ambassadorsRepository,
        systemMembership,
        notifications,
      } = buildService();

      const granted = await service.grant(grantInput, 'staff-1');

      expect(ambassadorsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'member-1',
          focusArea: 'housing',
          grantedById: 'staff-1',
          grantReason: 'Runs the housing help desk',
          revokedAt: null,
        }),
      );
      expect(systemMembership.addMember).toHaveBeenCalledWith(
        'circle-1',
        'member-1',
        RosterRole.Member,
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'member-1',
        NotificationType.AmbassadorGranted,
        { focusArea: 'housing', communitySlug: 'queerpulse-ambassadors' },
      );
      expect(granted.member.slug).toBe('rui');
      expect(granted.grantedBy).toEqual({ slug: 'ana', name: 'Ana Silva' });
      expect(granted.inviteQuotaOverride).toBeNull();
    });

    it('refuses a member with an active grant with 409 ambassador_already_active', async () => {
      const { service, ambassadorsRepository } = buildService({
        hasActiveGrant: true,
      });

      await expectCodedError(
        service.grant(grantInput, 'staff-1'),
        ConflictException,
        'ambassador_already_active',
      );
      expect(ambassadorsRepository.save).not.toHaveBeenCalled();
    });

    it('maps a unique violation from a racing grant to 409 ambassador_already_active', async () => {
      const { service, systemMembership } = buildService({
        saveError: { code: '23505', constraint: 'UQ_ambassadors_active_user' },
      });

      await expectCodedError(
        service.grant(grantInput, 'staff-1'),
        ConflictException,
        'ambassador_already_active',
      );
      expect(systemMembership.addMember).not.toHaveBeenCalled();
    });

    it('refuses a self-grant with 403 ambassador_self_grant', async () => {
      const { service } = buildService({
        profileBySlug: { userId: 'staff-1' },
      });

      await expectCodedError(
        service.grant(grantInput, 'staff-1'),
        ForbiddenException,
        'ambassador_self_grant',
      );
    });

    it('refuses a system user with 400 ambassador_ineligible_member', async () => {
      const { service } = buildService({
        user: { id: 'member-1', isSystem: true, status: UserStatus.Active },
      });

      await expectCodedError(
        service.grant(grantInput, 'staff-1'),
        BadRequestException,
        'ambassador_ineligible_member',
      );
    });

    it('refuses a non-active account with 400 ambassador_ineligible_member', async () => {
      const { service, circleService } = buildService({
        user: {
          id: 'member-1',
          isSystem: false,
          status: UserStatus.Suspended,
        },
      });

      await expectCodedError(
        service.grant(grantInput, 'staff-1'),
        BadRequestException,
        'ambassador_ineligible_member',
      );
      expect(circleService.resolveCircle).not.toHaveBeenCalled();
    });

    it('refuses an unknown slug with 404 ambassador_member_not_found', async () => {
      const { service } = buildService({ profileBySlug: null });

      await expectCodedError(
        service.grant(grantInput, 'staff-1'),
        NotFoundException,
        'ambassador_member_not_found',
      );
    });

    it('writes nothing when the circle cannot be resolved', async () => {
      const { service, circleService, ambassadorsRepository } = buildService();
      circleService.resolveCircle.mockRejectedValue(new Error('no circle'));

      await expect(service.grant(grantInput, 'staff-1')).rejects.toThrow(
        'no circle',
      );
      expect(ambassadorsRepository.save).not.toHaveBeenCalled();
    });

    it('deletes the just-inserted row when the circle join fails', async () => {
      const { service, ambassadorsRepository, notifications } = buildService({
        addMemberError: new Error('join failed'),
      });

      await expect(service.grant(grantInput, 'staff-1')).rejects.toThrow(
        'join failed',
      );
      expect(ambassadorsRepository.delete).toHaveBeenCalledWith({
        id: 'grant-new',
      });
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('re-grants after a revoke with a new row and a fresh circle join (Review Focus 3)', async () => {
      // The earlier grant is stamped revoked, so no active row blocks this
      // one, and the member left the circle on the revoke. The mock models
      // that history: a row exists for the member, and only a read filtered
      // to active rows comes back empty. A pre-check that dropped the
      // `revokedAt IS NULL` filter would see the old row and answer 409.
      const { service, ambassadorsRepository, systemMembership } =
        buildService();
      ambassadorsRepository.exists.mockImplementation(
        (findOptions: { where: { revokedAt?: unknown } }) =>
          Promise.resolve(!('revokedAt' in findOptions.where)),
      );

      await service.grant(grantInput, 'staff-1');

      expect(ambassadorsRepository.exists).toHaveBeenCalledWith({
        where: { userId: 'member-1', revokedAt: IsNull() },
      });
      expect(ambassadorsRepository.save).toHaveBeenCalledTimes(1);
      expect(ambassadorsRepository.save).toHaveBeenCalledWith(
        expect.not.objectContaining({ id: expect.anything() as unknown }),
      );
      expect(systemMembership.addMember).toHaveBeenCalledWith(
        'circle-1',
        'member-1',
        RosterRole.Member,
      );
    });

    it('keeps the grant when the notification fails', async () => {
      const { service, ambassadorsRepository } = buildService({
        notificationError: new Error('notifications down'),
      });

      const granted = await service.grant(grantInput, 'staff-1');

      expect(granted.id).toBe('grant-1');
      expect(ambassadorsRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('stamps the row, removes only a member row from the circle and notifies', async () => {
      const {
        service,
        ambassadorsRepository,
        systemMembership,
        notifications,
      } = buildService();

      await service.revoke('grant-1', 'Stepped back', 'staff-1');

      expect(ambassadorsRepository.update).toHaveBeenCalledWith(
        { id: 'grant-1', revokedAt: expect.anything() as unknown },
        {
          revokedAt: expect.any(Date) as unknown,
          revokedById: 'staff-1',
          revokeReason: 'Stepped back',
        },
      );
      expect(systemMembership.removeMemberIfRole).toHaveBeenCalledWith(
        'circle-1',
        'member-1',
        RosterRole.Member,
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'member-1',
        NotificationType.AmbassadorRevoked,
        {},
      );
    });

    it('keeps a staff mod seat in the circle (Review Focus 1)', async () => {
      // `removeMemberIfRole` deletes by role, so a `mod` row matches nothing.
      const { service, systemMembership } = buildService();
      systemMembership.removeMemberIfRole.mockResolvedValue(false);

      await service.revoke('grant-1', 'Stepped back', 'staff-1');

      expect(systemMembership.removeMemberIfRole).toHaveBeenCalledWith(
        'circle-1',
        'member-1',
        RosterRole.Member,
      );
      expect(systemMembership.removeMemberIfRole).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        RosterRole.Mod,
      );
    });

    it('answers 404 ambassador_not_found for a revoked or unknown id', async () => {
      const { service, systemMembership, notifications } = buildService({
        activeRowForRevoke: null,
      });

      await expectCodedError(
        service.revoke('grant-gone', 'Stepped back', 'staff-1'),
        NotFoundException,
        'ambassador_not_found',
      );
      expect(systemMembership.removeMemberIfRole).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('answers 404 when a concurrent revoke stamped the row first', async () => {
      const { service, notifications } = buildService({ updateAffected: 0 });

      await expectCodedError(
        service.revoke('grant-1', 'Stepped back', 'staff-1'),
        NotFoundException,
        'ambassador_not_found',
      );
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('updateFocusArea', () => {
    it('answers 404 ambassador_not_found for a grant that is no longer active', async () => {
      const { service } = buildService({ updateAffected: 0 });

      await expectCodedError(
        service.updateFocusArea('grant-1', 'youth', 'staff-1'),
        NotFoundException,
        'ambassador_not_found',
      );
    });
  });

  describe('takeStaffSeat', () => {
    it('adds the caller to the circle as mod', async () => {
      const { service, systemMembership } = buildService();

      await expect(service.takeStaffSeat('staff-1')).resolves.toEqual({
        slug: 'queerpulse-ambassadors',
      });
      expect(systemMembership.addMember).toHaveBeenCalledWith(
        'circle-1',
        'staff-1',
        RosterRole.Mod,
      );
    });

    it('is a no-op for a caller who already holds a seat', async () => {
      // `addMember` reports false when ON CONFLICT DO NOTHING absorbed it.
      const { service, systemMembership } = buildService();
      systemMembership.addMember.mockResolvedValue(false);

      await expect(service.takeStaffSeat('staff-1')).resolves.toEqual({
        slug: 'queerpulse-ambassadors',
      });
      expect(systemMembership.removeMemberIfRole).not.toHaveBeenCalled();
    });
  });

  describe('releaseStaffSeat (ENG-457)', () => {
    function buildReleaseService(options: {
      role?: UserRole;
      holdsStaffGrant?: boolean;
      hasActiveGrant?: boolean;
    }) {
      const built = buildService({
        user: { id: 'staff-1', role: options.role ?? UserRole.Member },
        hasActiveGrant: options.hasActiveGrant ?? false,
      });
      built.staffRolesRepository.exists.mockResolvedValue(
        options.holdsStaffGrant ?? false,
      );
      return built;
    }

    it('removes the mod seat of a former partnerships holder who is not an ambassador', async () => {
      const { service, systemMembership, communityMembersRepository } =
        buildReleaseService({});

      await service.releaseStaffSeat('staff-1');

      expect(systemMembership.removeMemberIfRole).toHaveBeenCalledWith(
        'circle-1',
        'staff-1',
        RosterRole.Mod,
      );
      expect(communityMembersRepository.update).not.toHaveBeenCalled();
    });

    it('demotes an active ambassador to a plain member seat, keeping them in the circle', async () => {
      const {
        service,
        systemMembership,
        communityMembersRepository,
        ambassadorsRepository,
      } = buildReleaseService({ hasActiveGrant: true });

      await service.releaseStaffSeat('staff-1');

      expect(ambassadorsRepository.exists).toHaveBeenCalledWith({
        where: { userId: 'staff-1', revokedAt: IsNull() },
      });
      expect(communityMembersRepository.update).toHaveBeenCalledWith(
        { communityId: 'circle-1', userId: 'staff-1', role: RosterRole.Mod },
        { role: RosterRole.Member },
      );
      expect(systemMembership.removeMemberIfRole).not.toHaveBeenCalled();
    });

    it('leaves an admin seated, since the admin tier still qualifies', async () => {
      const { service, systemMembership, communityMembersRepository } =
        buildReleaseService({ role: UserRole.Admin });

      await service.releaseStaffSeat('staff-1');

      expect(systemMembership.removeMemberIfRole).not.toHaveBeenCalled();
      expect(communityMembersRepository.update).not.toHaveBeenCalled();
    });

    it('leaves a member seated who still holds the partnerships grant', async () => {
      const {
        service,
        staffRolesRepository,
        systemMembership,
        communityMembersRepository,
      } = buildReleaseService({ holdsStaffGrant: true });

      await service.releaseStaffSeat('staff-1');

      expect(staffRolesRepository.exists).toHaveBeenCalledWith({
        where: { userId: 'staff-1', role: 'partnerships' },
      });
      expect(systemMembership.removeMemberIfRole).not.toHaveBeenCalled();
      expect(communityMembersRepository.update).not.toHaveBeenCalled();
    });

    it('does nothing, and founds nothing, before the circle exists', async () => {
      const { service, circleService, systemMembership, usersRepository } =
        buildReleaseService({});
      circleService.findCircle.mockResolvedValue(null);

      await service.releaseStaffSeat('staff-1');

      expect(circleService.resolveCircle).not.toHaveBeenCalled();
      expect(usersRepository.findOne).not.toHaveBeenCalled();
      expect(systemMembership.removeMemberIfRole).not.toHaveBeenCalled();
    });
  });

  describe('getCircleSummary', () => {
    it('reports the slug, the head count and whether the viewer holds a seat', async () => {
      const { service } = buildService();

      await expect(service.getCircleSummary('staff-1')).resolves.toEqual({
        isFounded: true,
        slug: 'queerpulse-ambassadors',
        memberCount: 4,
        isViewerMember: true,
      });
    });

    it('answers the not-founded state before the first grant and creates nothing (ENG-459)', async () => {
      const { service, circleService, communityMembersRepository } =
        buildService();
      circleService.findCircle.mockResolvedValue(null);

      await expect(service.getCircleSummary('staff-1')).resolves.toEqual({
        isFounded: false,
        slug: null,
        memberCount: 0,
        isViewerMember: false,
      });
      expect(circleService.resolveCircle).not.toHaveBeenCalled();
      expect(communityMembersRepository.count).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('maps rows with the override and the granting staff member', async () => {
      const { service, ambassadorsRepository } = buildService();
      ambassadorsRepository.findAndCount.mockResolvedValue([
        [
          buildGrantRow({
            user: {
              id: 'member-1',
              inviteMonthlyQuota: 3,
              profile: memberProfile,
            } as unknown as User,
          }),
        ],
        1,
      ]);

      const result = await service.list('active');

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 'grant-1',
        member: { userId: 'member-1', slug: 'rui' },
        focusArea: 'housing',
        isTagVisible: true,
        inviteQuotaOverride: 3,
        grantedBy: { slug: 'ana', name: 'Ana Silva' },
        revokedBy: null,
      });
    });

    it('pages with the shared envelope, past grants most recently revoked first (ENG-458)', async () => {
      const { service, ambassadorsRepository } = buildService();
      ambassadorsRepository.findAndCount.mockResolvedValue([
        [buildGrantRow()],
        45,
      ]);

      const result = await service.list('past', 3);

      expect(ambassadorsRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          order: { revokedAt: 'DESC', id: 'ASC' },
          skip: 40,
          take: 20,
        }),
      );
      expect(result).toMatchObject({ total: 45, page: 3, pageSize: 20 });
    });
  });

  describe('historyFor', () => {
    it("lists every one of the member's grants, newest first (ENG-458)", async () => {
      const { service, ambassadorsRepository } = buildService();
      ambassadorsRepository.find.mockResolvedValue([
        buildGrantRow({ id: 'grant-2' }),
        buildGrantRow({
          id: 'grant-1',
          revokedAt: new Date('2026-05-01T10:00:00Z'),
          revokedById: 'staff-1',
          revokeReason: 'Stepped back',
        }),
      ]);

      const rows = await service.historyFor('member-1');

      expect(ambassadorsRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'member-1' },
          order: { grantedAt: 'DESC', id: 'ASC' },
        }),
      );
      expect(rows.map((row) => row.id)).toEqual(['grant-2', 'grant-1']);
      expect(rows[1]).toMatchObject({
        revokeReason: 'Stepped back',
        revokedBy: { slug: 'ana', name: 'Ana Silva' },
      });
    });
  });
});

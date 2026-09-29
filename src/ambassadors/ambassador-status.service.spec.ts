import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { BADGED_STAFF_ROLE_IDS } from '../users/staff-roles.registry';
import { AMBASSADOR_INVITE_BONUS } from './ambassador-focus-areas';
import {
  AmbassadorStatusService,
  NOT_BADGED_STAFF_PARAMETERS,
  notBadgedStaffClause,
} from './ambassador-status.service';
import { Ambassador } from './entities/ambassador.entity';

/**
 * These cover the two ways the invite bonus and the roster can drift from the
 * grant: a revoke that should zero the bonus immediately, and a hidden tag
 * that should pull a member off the public roster while the grant (and its
 * perks) stay active underneath.
 */

const activeRow = {
  id: 'ambassador-1',
  userId: 'user-1',
  focusArea: 'housing',
  revokedAt: null,
} as unknown as Ambassador;

describe('AmbassadorStatusService', () => {
  function buildQueryBuilder(rows: unknown[]) {
    const queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    };
    return queryBuilder;
  }

  function buildProfileQueryBuilder(isVisibleProfileFound: boolean) {
    const profileQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getExists: jest.fn().mockResolvedValue(isVisibleProfileFound),
    };
    return profileQueryBuilder;
  }

  async function buildService(options: {
    findOneResult?: Ambassador | null;
    isVisibleProfileFound?: boolean;
    rosterRows?: unknown[];
  }) {
    const queryBuilder = buildQueryBuilder(options.rosterRows ?? []);
    const profileQueryBuilder = buildProfileQueryBuilder(
      options.isVisibleProfileFound ?? false,
    );
    const ambassadorsRepository = {
      findOne: jest.fn().mockResolvedValue(options.findOneResult ?? null),
      createQueryBuilder: jest.fn(() => queryBuilder),
    };
    const profilesRepository = {
      createQueryBuilder: jest.fn(() => profileQueryBuilder),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AmbassadorStatusService,
        {
          provide: getRepositoryToken(Ambassador),
          useValue: ambassadorsRepository,
        },
        {
          provide: getRepositoryToken(Profile),
          useValue: profilesRepository,
        },
      ],
    }).compile();
    return {
      service: moduleRef.get(AmbassadorStatusService),
      ambassadorsRepository,
      profilesRepository,
      queryBuilder,
      profileQueryBuilder,
    };
  }

  it('gives the invite bonus to an active ambassador', async () => {
    const { service } = await buildService({ findOneResult: activeRow });

    expect(await service.getInviteBonus('user-1')).toBe(
      AMBASSADOR_INVITE_BONUS,
    );
  });

  it('gives no invite bonus once the grant is revoked', async () => {
    const { service } = await buildService({ findOneResult: null });

    expect(await service.getInviteBonus('user-1')).toBe(0);
  });

  it('treats a hidden tag as not visible even while the grant is active', async () => {
    const { service, profileQueryBuilder } = await buildService({
      findOneResult: activeRow,
      isVisibleProfileFound: false,
    });

    expect(await service.isVisibleAmbassador('user-1')).toBe(false);
    expect(profileQueryBuilder.andWhere).toHaveBeenCalledWith(
      'profile.isAmbassadorTagVisible = true',
    );
  });

  it('names an active ambassador with a visible tag and no staff badge', async () => {
    const { service } = await buildService({
      findOneResult: activeRow,
      isVisibleProfileFound: true,
    });

    expect(await service.isVisibleAmbassador('user-1')).toBe(true);
  });

  it('never names a staff member as an ambassador on the invitee line', async () => {
    // The staff clause is part of the one EXISTS query, so a badged member
    // with an active grant and a visible tag comes back as no match.
    const { service, profileQueryBuilder } = await buildService({
      findOneResult: activeRow,
      isVisibleProfileFound: false,
    });

    expect(await service.isVisibleAmbassador('user-1')).toBe(false);
    expect(profileQueryBuilder.andWhere).toHaveBeenCalledWith(
      notBadgedStaffClause('"profile"."user_id"'),
      NOT_BADGED_STAFF_PARAMETERS,
    );
  });

  it('skips the profile query when there is no active grant', async () => {
    const { service, profilesRepository } = await buildService({
      findOneResult: null,
      isVisibleProfileFound: true,
    });

    expect(await service.isVisibleAmbassador('user-1')).toBe(false);
    expect(profilesRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('builds the roster from active grants on active accounts with a visible tag', async () => {
    const { service, queryBuilder } = await buildService({
      rosterRows: [
        {
          slug: 'rui',
          focusArea: 'housing',
          grantedAt: new Date('2026-01-01'),
        },
      ],
    });

    await service.listVisibleRoster();

    expect(queryBuilder.where).toHaveBeenCalledWith(
      'ambassador.revokedAt IS NULL',
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'user.status = :activeStatus',
      { activeStatus: UserStatus.Active },
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'profile.isAmbassadorTagVisible = true',
    );
  });

  it('returns every visible ambassador, newest grant first, with no cap (ENG-458)', async () => {
    const { service, queryBuilder } = await buildService({ rosterRows: [] });

    await service.listVisibleRoster();

    expect(queryBuilder.orderBy).toHaveBeenCalledWith(
      'ambassador.grantedAt',
      'DESC',
    );
    expect(queryBuilder.limit).not.toHaveBeenCalled();
  });

  it('keeps staff members off the roster', async () => {
    const { service, queryBuilder } = await buildService({ rosterRows: [] });

    await service.listVisibleRoster();

    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      notBadgedStaffClause('"ambassador"."user_id"'),
      NOT_BADGED_STAFF_PARAMETERS,
    );
  });

  it('drops a roster row whose focus area this build does not know', async () => {
    const { service } = await buildService({
      rosterRows: [
        {
          slug: 'known-area',
          focusArea: 'housing',
          grantedAt: new Date('2026-01-01'),
        },
        {
          slug: 'unknown-area',
          focusArea: 'unknown_key',
          grantedAt: new Date('2026-01-02'),
        },
      ],
    });

    const roster = await service.listVisibleRoster();

    expect(roster).toHaveLength(1);
    expect(roster[0]?.slug).toBe('known-area');
  });
});

describe('notBadgedStaffClause', () => {
  it('excludes both staff account tiers and every badged staff grant', () => {
    const clause = notBadgedStaffClause('"member"."user_id"');

    expect(clause).toContain('FROM "users" "staffAccount"');
    expect(clause).toContain('"staffAccount"."id" = "member"."user_id"');
    expect(clause).toContain('IN (:...staffAccountRoles)');
    expect(NOT_BADGED_STAFF_PARAMETERS.staffAccountRoles).toEqual([
      UserRole.Moderator,
      UserRole.Admin,
    ]);
    expect(BADGED_STAFF_ROLE_IDS.length).toBeGreaterThan(0);
    expect(clause).toContain('FROM "user_staff_roles" "staffGrant"');
    expect(clause).toContain('"staffGrant"."user_id" = "member"."user_id"');
    expect(clause).toContain('IN (:...badgedStaffRoles)');
    expect(NOT_BADGED_STAFF_PARAMETERS.badgedStaffRoles).toEqual(
      BADGED_STAFF_ROLE_IDS,
    );
  });
});

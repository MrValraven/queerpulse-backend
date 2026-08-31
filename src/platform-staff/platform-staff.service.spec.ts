import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { PlatformStaffService } from './platform-staff.service';

/**
 * The roster is the platform's public statement about who runs it, so these
 * cover the two things that statement can get wrong: leaving out someone who
 * exercises power over other members' content (ENG-28), and putting someone on
 * it who should not be there.
 */

type StaffFixture = {
  id: string;
  role: UserRole;
  status: UserStatus;
  slug: string | null;
  firstName: string;
  lastName: string;
};

function userFixture(fixture: StaffFixture): User {
  return {
    id: fixture.id,
    role: fixture.role,
    status: fixture.status,
    profile: fixture.slug
      ? {
          slug: fixture.slug,
          firstName: fixture.firstName,
          lastName: fixture.lastName,
        }
      : undefined,
  } as unknown as User;
}

function grantFixture(userId: string, role: string): UserStaffRole {
  return { userId, role } as UserStaffRole;
}

describe('PlatformStaffService', () => {
  /**
   * The users repository is asked twice (tiers, then grant holders), so the
   * stub answers from the `where` it was handed rather than from call order.
   */
  function buildService(users: User[], grants: UserStaffRole[]) {
    const usersRepository = {
      find: jest.fn(
        async (options: {
          where: { role?: unknown; id?: unknown; status: UserStatus };
        }) => {
          const isTierQuery = 'role' in options.where;
          // `In([...])` arrives as a TypeORM `FindOperator`; its `value` getter
          // is the array that was passed in.
          const wantedIds = (
            options.where.id as { value?: string[] } | undefined
          )?.value;
          return users.filter((candidate) => {
            if (candidate.status !== options.where.status) return false;
            if (isTierQuery) {
              return (
                candidate.role === UserRole.Moderator ||
                candidate.role === UserRole.Admin
              );
            }
            return (wantedIds ?? []).includes(candidate.id);
          });
        },
      ),
    };
    const grantsRepository = { find: jest.fn(async () => grants) };
    return Test.createTestingModule({
      providers: [
        PlatformStaffService,
        { provide: getRepositoryToken(User), useValue: usersRepository },
        {
          provide: getRepositoryToken(UserStaffRole),
          useValue: grantsRepository,
        },
      ],
    })
      .compile()
      .then((moduleRef) => moduleRef.get(PlatformStaffService));
  }

  const moderator = userFixture({
    id: 'moderator-1',
    role: UserRole.Moderator,
    status: UserStatus.Active,
    slug: 'mariana',
    firstName: 'Mariana',
    lastName: 'Loucao',
  });
  const housingGrantHolder = userFixture({
    id: 'member-1',
    role: UserRole.Member,
    status: UserStatus.Active,
    slug: 'rui',
    firstName: 'Rui',
    lastName: 'Marcal',
  });

  it('rosters a member-tier holder of a badged grant, with no account tier', async () => {
    const service = await buildService(
      [moderator, housingGrantHolder],
      [grantFixture('member-1', 'housing_moderator')],
    );

    const roster = await service.list();

    expect(roster).toEqual([
      {
        slug: 'mariana',
        firstName: 'Mariana',
        lastName: 'Loucao',
        platformRole: UserRole.Moderator,
        badgedStaffRoles: [],
      },
      {
        slug: 'rui',
        firstName: 'Rui',
        lastName: 'Marcal',
        platformRole: null,
        badgedStaffRoles: ['housing_moderator'],
      },
    ]);
  });

  it('leaves the unbadged grants off the roster', async () => {
    const writerOnly = userFixture({
      id: 'member-2',
      role: UserRole.Member,
      status: UserStatus.Active,
      slug: 'sofia',
      firstName: 'Sofia',
      lastName: 'Neves',
    });
    // The grants repository is queried with an `In(BADGED_STAFF_ROLE_IDS)`
    // filter, so in real life these rows never come back. The stub returns them
    // anyway to prove the mapping layer drops them too.
    const service = await buildService(
      [writerOnly],
      [
        grantFixture('member-2', 'magazine_writer'),
        grantFixture('member-2', 'partnerships'),
      ],
    );

    expect(await service.list()).toEqual([]);
  });

  it('gives an admin their tier and their grants at once, without duplicating them', async () => {
    const admin = userFixture({
      id: 'admin-1',
      role: UserRole.Admin,
      status: UserStatus.Active,
      slug: 'tiago',
      firstName: 'Tiago',
      lastName: 'Costa',
    });
    const service = await buildService(
      [admin],
      [
        grantFixture('admin-1', 'communities'),
        grantFixture('admin-1', 'editorial'),
      ],
    );

    // Registry order on `badgedStaffRoles`, so the badge row reads the same way
    // on every surface however the grant rows happened to come back.
    expect(await service.list()).toEqual([
      {
        slug: 'tiago',
        firstName: 'Tiago',
        lastName: 'Costa',
        platformRole: UserRole.Admin,
        badgedStaffRoles: ['editorial', 'communities'],
      },
    ]);
  });

  it('drops a grant holder who is not active and one with no profile slug', async () => {
    const suspended = userFixture({
      id: 'member-3',
      role: UserRole.Member,
      status: UserStatus.Suspended,
      slug: 'joana',
      firstName: 'Joana',
      lastName: 'Dias',
    });
    const withoutProfile = userFixture({
      id: 'member-4',
      role: UserRole.Member,
      status: UserStatus.Active,
      slug: null,
      firstName: '',
      lastName: '',
    });
    const service = await buildService(
      [suspended, withoutProfile],
      [
        grantFixture('member-3', 'directory_moderator'),
        grantFixture('member-4', 'resource_curator'),
      ],
    );

    expect(await service.list()).toEqual([]);
  });

  it('drops a grant row holding a role id this build does not know', async () => {
    const service = await buildService(
      [housingGrantHolder],
      [grantFixture('member-1', 'role_from_a_later_build')],
    );

    expect(await service.list()).toEqual([]);
  });
});

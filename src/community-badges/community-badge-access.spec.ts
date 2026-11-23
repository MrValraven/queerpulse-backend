import { HttpException, NotFoundException } from '@nestjs/common';
import { IsNull, Repository } from 'typeorm';
import { RosterRole } from '../communities/entities/community-member.entity';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import {
  CommunityBadgeAccessDeps,
  CommunityBadgeRoleTier,
  resolveForAnyCaller,
  resolveForBoardRead,
  resolveForRole,
} from './community-badge-access';
import { CommunityBadgeRefusalCode } from './community-badges.constants';

describe('community badge access', () => {
  let communities: { findOne: jest.Mock };
  let membership: { effectiveRole: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };
  let deps: CommunityBadgeAccessDeps;

  beforeEach(() => {
    communities = { findOne: jest.fn() };
    membership = { effectiveRole: jest.fn() };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    deps = {
      communities: communities as unknown as Repository<Community>,
      membership,
      contentModeration,
    };
    stage({ accessTier: AccessTier.Public }, RosterRole.Owner);
  });

  /** Make the slug resolve to a community with these overrides, and the
   *  caller to this effective role. */
  function stage(overrides: Partial<Community>, role: RosterRole | null): void {
    communities.findOne.mockResolvedValue({
      id: 'community-1',
      slug: 'night-swim',
      archivedAt: null,
      parentId: null,
      accessTier: AccessTier.Public,
      ...overrides,
    });
    membership.effectiveRole.mockResolvedValue(role);
  }

  function staffInput(
    refusalCode: CommunityBadgeRefusalCode | 'COMMUNITY_MEMBERS_ONLY',
  ): {
    slug: string;
    userId: string;
    isWrite: boolean;
    tier: CommunityBadgeRoleTier;
    refusalCode: CommunityBadgeRefusalCode | 'COMMUNITY_MEMBERS_ONLY';
  } {
    return {
      slug: 'night-swim',
      userId: 'u1',
      isWrite: false,
      tier: 'staff',
      refusalCode,
    };
  }

  async function codeOfRejection(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      return ((error as HttpException).getResponse() as { code?: string }).code;
    }
    throw new Error('Expected the call to reject');
  }

  describe('resolveForRole', () => {
    it('404s a private outsider on a staff route before any role code', async () => {
      stage({ accessTier: AccessTier.Private }, null);
      await expect(
        resolveForRole(deps, staffInput('badge_settings_staff_only')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      [null, AccessTier.Request],
      [RosterRole.Member, AccessTier.Public],
    ])(
      'answers the route code to role %p on a %s community',
      async (role, accessTier) => {
        stage({ accessTier }, role);
        expect(
          await codeOfRejection(
            resolveForRole(deps, staffInput('badge_settings_staff_only')),
          ),
        ).toBe('badge_settings_staff_only');
      },
    );

    it('admits a mod to staff routes and refuses one on owner-level routes', async () => {
      stage({ accessTier: AccessTier.Public }, RosterRole.Mod);
      await expect(
        resolveForRole(deps, staffInput('gift_sender_not_staff')),
      ).resolves.toEqual(expect.objectContaining({ role: RosterRole.Mod }));
      expect(
        await codeOfRejection(
          resolveForRole(deps, {
            ...staffInput('badge_manage_owner_only'),
            tier: 'owner_level',
          }),
        ),
      ).toBe('badge_manage_owner_only');
    });

    it('admits a co-owner to owner-level routes', async () => {
      stage({ accessTier: AccessTier.Public }, RosterRole.CoOwner);
      await expect(
        resolveForRole(deps, {
          ...staffInput('badge_manage_owner_only'),
          tier: 'owner_level',
        }),
      ).resolves.toEqual(expect.objectContaining({ role: RosterRole.CoOwner }));
    });

    it('admits any roster role on the member tier', async () => {
      stage({ accessTier: AccessTier.Public }, RosterRole.Member);
      await expect(
        resolveForRole(deps, {
          ...staffInput('COMMUNITY_MEMBERS_ONLY'),
          tier: 'member',
        }),
      ).resolves.toEqual(expect.objectContaining({ role: RosterRole.Member }));
    });

    it('answers COMMUNITY_MEMBERS_ONLY to a public non-member on the member tier', async () => {
      stage({ accessTier: AccessTier.Public }, null);
      expect(
        await codeOfRejection(
          resolveForRole(deps, {
            ...staffInput('COMMUNITY_MEMBERS_ONLY'),
            tier: 'member',
          }),
        ),
      ).toBe('COMMUNITY_MEMBERS_ONLY');
    });

    it('answers a space with the space code after the access check', async () => {
      stage(
        { accessTier: AccessTier.Private, parentId: 'parent-1' },
        RosterRole.CoOwner,
      );
      expect(
        await codeOfRejection(
          resolveForRole(deps, {
            ...staffInput('badge_manage_owner_only'),
            tier: 'owner_level',
          }),
        ),
      ).toBe('SUBCOMMUNITY_FEATURE_UNAVAILABLE');
    });

    it('answers the role code before the space code', async () => {
      stage(
        { accessTier: AccessTier.Public, parentId: 'parent-1' },
        RosterRole.Member,
      );
      expect(
        await codeOfRejection(
          resolveForRole(deps, staffInput('badge_settings_staff_only')),
        ),
      ).toBe('badge_settings_staff_only');
    });

    it('keeps a private space a 404 to an outsider', async () => {
      stage({ accessTier: AccessTier.Private, parentId: 'parent-1' }, null);
      await expect(
        resolveForRole(deps, staffInput('badge_settings_staff_only')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s an unknown slug', async () => {
      communities.findOne.mockResolvedValue(null);
      await expect(
        resolveForRole(deps, staffInput('badge_settings_staff_only')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('loads writes with the archive filter and reads without it', async () => {
      await resolveForRole(deps, {
        ...staffInput('gift_sender_not_staff'),
        isWrite: true,
      });
      expect(communities.findOne).toHaveBeenLastCalledWith({
        where: { slug: 'night-swim', archivedAt: IsNull() },
      });
      await resolveForBoardRead(deps, { slug: 'night-swim', userId: 'u1' });
      expect(communities.findOne).toHaveBeenLastCalledWith({
        where: { slug: 'night-swim' },
      });
    });
  });

  describe('resolveForBoardRead', () => {
    it('answers COMMUNITY_MEMBERS_ONLY to a gated non-member on a board read', async () => {
      stage({ accessTier: AccessTier.Invite }, null);
      expect(
        await codeOfRejection(
          resolveForBoardRead(deps, { slug: 'night-swim', userId: 'u1' }),
        ),
      ).toBe('COMMUNITY_MEMBERS_ONLY');
    });

    it('404s a private outsider on a board read', async () => {
      stage({ accessTier: AccessTier.Private }, null);
      await expect(
        resolveForBoardRead(deps, { slug: 'night-swim', userId: 'u1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('serves a public community to a viewer with no role', async () => {
      stage({ accessTier: AccessTier.Public }, null);
      await expect(
        resolveForBoardRead(deps, { slug: 'night-swim', userId: 'u1' }),
      ).resolves.toEqual(expect.objectContaining({ role: null }));
    });

    it('serves an archived community to its roster', async () => {
      stage(
        { accessTier: AccessTier.Public, archivedAt: new Date() },
        RosterRole.Member,
      );
      await expect(
        resolveForBoardRead(deps, { slug: 'night-swim', userId: 'u1' }),
      ).resolves.toEqual(expect.objectContaining({ role: RosterRole.Member }));
    });

    it('404s a taken-down community to a plain member and serves it to staff', async () => {
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });
      stage({ accessTier: AccessTier.Public }, RosterRole.Member);
      await expect(
        resolveForBoardRead(deps, { slug: 'night-swim', userId: 'u1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      stage({ accessTier: AccessTier.Public }, RosterRole.Mod);
      await expect(
        resolveForBoardRead(deps, { slug: 'night-swim', userId: 'u1' }),
      ).resolves.toEqual(expect.objectContaining({ role: RosterRole.Mod }));
    });

    it('answers a space with the space code once the board gate passes', async () => {
      stage(
        { accessTier: AccessTier.Public, parentId: 'parent-1' },
        RosterRole.Member,
      );
      expect(
        await codeOfRejection(
          resolveForBoardRead(deps, { slug: 'night-swim', userId: 'u1' }),
        ),
      ).toBe('SUBCOMMUNITY_FEATURE_UNAVAILABLE');
    });
  });

  describe('resolveForAnyCaller', () => {
    it('admits a non-member of a public community', async () => {
      stage({ accessTier: AccessTier.Public }, null);
      await expect(
        resolveForAnyCaller(deps, {
          slug: 'night-swim',
          userId: 'u1',
          isWrite: true,
        }),
      ).resolves.toEqual(expect.objectContaining({ role: null }));
    });

    it('404s a private outsider', async () => {
      stage({ accessTier: AccessTier.Private }, null);
      await expect(
        resolveForAnyCaller(deps, {
          slug: 'night-swim',
          userId: 'u1',
          isWrite: false,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers a space with the space code', async () => {
      stage(
        { accessTier: AccessTier.Public, parentId: 'parent-1' },
        RosterRole.Member,
      );
      expect(
        await codeOfRejection(
          resolveForAnyCaller(deps, {
            slug: 'night-swim',
            userId: 'u1',
            isWrite: false,
          }),
        ),
      ).toBe('SUBCOMMUNITY_FEATURE_UNAVAILABLE');
    });

    it('applies the archive filter to writes only', async () => {
      await resolveForAnyCaller(deps, {
        slug: 'night-swim',
        userId: 'u1',
        isWrite: true,
      });
      expect(communities.findOne).toHaveBeenLastCalledWith({
        where: { slug: 'night-swim', archivedAt: IsNull() },
      });
      await resolveForAnyCaller(deps, {
        slug: 'night-swim',
        userId: 'u1',
        isWrite: false,
      });
      expect(communities.findOne).toHaveBeenLastCalledWith({
        where: { slug: 'night-swim' },
      });
    });
  });
});

import type { EntityManager } from 'typeorm';
import type { MediaCropService } from '../media-crops/media-crops.service';
import {
  SubprofileKind,
  SubprofileLinkVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { DirectoryController } from './directory.controller';
import {
  loadPublicTeam,
  type ListingTeamViewer,
} from './listing-team-public-team';
import type {
  ListingTeamMemberColumns,
  ListingTeamMemberProfile,
  ListingTeamMemberPublic,
  ListingTeamPersonaColumns,
} from './listing-team-response';
import {
  anonymousVisibleMemberSql,
  anonymousVisiblePersonaSql,
  eligibleMemberSql,
  eligiblePersonaSql,
  notBlockedEitherWaySql,
  notHiddenFromViewerSql,
} from './listing-team-visibility';

const LISTING_ID = 'listing-1';

/** A team row the SQL returns for a persona entry. */
function personaRow(subprofileId: string, roleLabel: string | null) {
  return { subprofile_id: subprofileId, user_id: null, role_label: roleLabel };
}

/** A team row the SQL returns for a member entry. */
function memberRow(userId: string, roleLabel: string | null) {
  return { subprofile_id: null, user_id: userId, role_label: roleLabel };
}

function makeMemberProfile(
  overrides: Partial<ListingTeamMemberColumns & { userId: string }> = {},
): ListingTeamMemberColumns & { userId: string } {
  return {
    userId: 'user-ana',
    slug: 'ana-silva',
    firstName: 'Ana',
    lastName: 'Silva',
    avatarUrl: 'uploads/ana.jpg',
    photoVisible: true,
    ...overrides,
  };
}

/** The member half of an entry; fails the test for a persona entry. */
function memberOf(entry: ListingTeamMemberPublic): ListingTeamMemberProfile {
  if (entry.kind !== 'member') {
    throw new Error('expected a member entry');
  }
  return entry.member;
}

/** The only entry of a one-entry team; fails the test when it is missing. */
function entryOf(team: ListingTeamMemberPublic[]): ListingTeamMemberPublic {
  const [entry] = team;
  if (!entry) {
    throw new Error('expected a team entry');
  }
  return entry;
}

/** The entity the first lookup was made for; fails the test when none ran. */
function firstFindEntity(find: jest.Mock): unknown {
  const [firstCall] = find.mock.calls as unknown[][];
  if (!firstCall) {
    throw new Error('expected a lookup');
  }
  return firstCall[0];
}

/** The persona handle, or the member slug, of each entry. */
function subjectsOf(team: ListingTeamMemberPublic[]): string[] {
  return team.map((entry) =>
    entry.kind === 'persona' ? entry.persona.handle : entry.member.slug,
  );
}

function makePersona(
  overrides: Partial<ListingTeamPersonaColumns> = {},
): ListingTeamPersonaColumns {
  return {
    id: 'persona-1',
    handle: 'ink-ana',
    displayName: 'Ink Ana',
    kind: SubprofileKind.Musician,
    avatarUrl: 'uploads/ink-ana.jpg',
    linkVisibility: SubprofileLinkVisibility.Unlinked,
    ...overrides,
  };
}

describe('loadPublicTeam', () => {
  let manager: { query: jest.Mock; find: jest.Mock };
  let mediaCropService: { getMany: jest.Mock };

  beforeEach(() => {
    manager = {
      query: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockResolvedValue([]),
    };
    mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
  });

  const load = (viewer: ListingTeamViewer) =>
    loadPublicTeam(
      manager as unknown as EntityManager,
      mediaCropService as unknown as MediaCropService,
      LISTING_ID,
      viewer,
    );

  /** The SQL text and parameters of the one team query. */
  const teamQuery = (): { sql: string; parameters: unknown[] } => {
    const [firstCall] = manager.query.mock.calls as [string, unknown[]][];
    if (firstCall === undefined) {
      throw new Error('the team query never ran');
    }
    return { sql: firstCall[0], parameters: firstCall[1] };
  };

  it('builds the anonymous team with no viewer parameter and open unlinked personas alone', async () => {
    await load({ isActiveMember: false, userId: null });

    const { sql, parameters } = teamQuery();
    expect(sql).toContain(anonymousVisiblePersonaSql('persona'));
    expect(sql).not.toContain('"blocks"');
    expect(sql).not.toContain('$2');
    expect(parameters).toEqual([LISTING_ID]);
  });

  it("widens an active member's team to members-only and linked personas and drops blocked owners", async () => {
    await load({ isActiveMember: true, userId: 'viewer-1' });

    const { sql, parameters } = teamQuery();
    expect(sql).not.toContain(anonymousVisiblePersonaSql('persona'));
    expect(sql).toContain(notBlockedEitherWaySql('$2', '"persona"."user_id"'));
    expect(parameters).toEqual([LISTING_ID, 'viewer-1']);
  });

  it('drops a persona whose owner has a block either way with a signed-in viewer', async () => {
    await load({ isActiveMember: false, userId: 'viewer-1' });

    const { sql, parameters } = teamQuery();
    expect(sql).toContain(anonymousVisiblePersonaSql('persona'));
    expect(sql).toContain(notBlockedEitherWaySql('$2', '"persona"."user_id"'));
    expect(parameters).toEqual([LISTING_ID, 'viewer-1']);
  });

  it('reads accepted rows of eligible personas alone, in position order, at most 40', async () => {
    await load({ isActiveMember: false, userId: null });

    const { sql } = teamQuery();
    expect(sql).toContain(eligiblePersonaSql('persona'));
    expect(sql).toContain(`"member"."listing_id" = $1`);
    expect(sql).toContain(`"member"."status" = 'accepted'`);
    expect(sql).toContain(
      'ORDER BY "member"."position" ASC, "member"."id" ASC',
    );
    expect(sql).toContain('LIMIT 40');
  });

  it('returns members in the order the SQL gave and skips the persona query when empty', async () => {
    const empty = await load({ isActiveMember: false, userId: null });

    expect(empty).toEqual([]);
    expect(manager.find).not.toHaveBeenCalled();
    expect(mediaCropService.getMany).not.toHaveBeenCalled();

    manager.query.mockResolvedValue([
      personaRow('persona-2', 'Bartender'),
      personaRow('persona-1', null),
    ]);
    manager.find.mockResolvedValue([
      makePersona(),
      makePersona({
        id: 'persona-2',
        handle: 'rui-sound',
        displayName: 'Rui Sound',
        avatarUrl: null,
      }),
    ]);

    const team = await load({ isActiveMember: false, userId: null });

    expect(team.map((entry) => [entry.kind, entry.roleLabel])).toEqual([
      ['persona', 'Bartender'],
      ['persona', null],
    ]);
    expect(subjectsOf(team)).toEqual(['rui-sound', 'ink-ana']);
    expect(mediaCropService.getMany).toHaveBeenCalledTimes(1);
    expect(mediaCropService.getMany).toHaveBeenCalledWith([
      'uploads/ink-ana.jpg',
    ]);
    expect(manager.find).toHaveBeenCalledTimes(1);
    expect(
      team.map((entry) =>
        entry.kind === 'persona' ? entry.persona.ownerName : undefined,
      ),
    ).toEqual([null, null]);
  });

  it('reads the owner names of linked personas in one query and names the linked persona alone', async () => {
    manager.query.mockResolvedValue([
      personaRow('persona-1', null),
      personaRow('persona-2', 'Poet'),
    ]);
    manager.find
      .mockResolvedValueOnce([
        { ...makePersona(), userId: 'owner-unlinked' },
        {
          ...makePersona({
            id: 'persona-2',
            handle: 'rui-poet',
            displayName: 'Poet',
            linkVisibility: SubprofileLinkVisibility.Linked,
          }),
          userId: 'owner-linked',
        },
      ])
      .mockResolvedValueOnce([
        { userId: 'owner-linked', firstName: 'Rui', lastName: 'Mendes' },
      ]);

    const team = await load({ isActiveMember: true, userId: 'viewer-1' });

    expect(manager.find).toHaveBeenCalledTimes(2);
    const [profileEntity, profileOptions] = manager.find.mock.calls[1] as [
      unknown,
      { where: { userId: { value: unknown } } },
    ];
    expect(profileEntity).toBe(Profile);
    expect(profileOptions.where.userId.value).toEqual(['owner-linked']);
    expect(
      team.map((entry) =>
        entry.kind === 'persona'
          ? [entry.persona.handle, entry.persona.ownerName]
          : [],
      ),
    ).toEqual([
      ['ink-ana', null],
      ['rui-poet', 'Rui Mendes'],
    ]);
  });

  describe('member entries', () => {
    it('shows a member to an anonymous caller only while public_profile_enabled is on', async () => {
      await load({ isActiveMember: false, userId: null });

      const { sql, parameters } = teamQuery();
      expect(sql).toContain(
        anonymousVisibleMemberSql('member_profile', 'member_user'),
      );
      expect(sql).toContain('"public_profile_enabled" = true');
      expect(sql).not.toContain('"hidden_from_members"');
      expect(sql).not.toContain('"blocks"');
      expect(sql).not.toContain('$2');
      expect(parameters).toEqual([LISTING_ID]);
    });

    it('joins the persona, profile and user rows so one query serves both kinds', async () => {
      await load({ isActiveMember: false, userId: null });

      const { sql } = teamQuery();
      expect(sql).not.toContain('INNER JOIN');
      expect(sql).toContain(
        'LEFT JOIN "subprofiles" "persona" ON "persona"."id" = "member"."subprofile_id"',
      );
      expect(sql).toContain(
        'LEFT JOIN "profiles" "member_profile" ON "member_profile"."user_id" = "member"."user_id"',
      );
      expect(sql).toContain(
        'LEFT JOIN "users" "member_user" ON "member_user"."id" = "member"."user_id"',
      );
      expect(sql).toContain(`"member"."subprofile_id" IS NOT NULL`);
      expect(sql).toContain(`"member"."user_id" IS NOT NULL`);
      expect(sql).toContain(eligiblePersonaSql('persona'));
    });

    it('drops a member with a block either way and one who hid the profile from a signed-in active member', async () => {
      await load({ isActiveMember: true, userId: 'viewer-1' });

      const { sql, parameters } = teamQuery();
      expect(sql).toContain(eligibleMemberSql('member_profile', 'member_user'));
      expect(sql).not.toContain('"public_profile_enabled"');
      expect(sql).toContain(notBlockedEitherWaySql('$2', '"member"."user_id"'));
      expect(sql).toContain(notHiddenFromViewerSql('$2', '"member"."user_id"'));
      expect(parameters).toEqual([LISTING_ID, 'viewer-1']);
    });

    it('keeps the public_profile_enabled gate for a signed-in caller who is not an active member', async () => {
      await load({ isActiveMember: false, userId: 'viewer-1' });

      const { sql } = teamQuery();
      expect(sql).toContain(
        anonymousVisibleMemberSql('member_profile', 'member_user'),
      );
      expect(sql).toContain(notBlockedEitherWaySql('$2', '"member"."user_id"'));
      expect(sql).toContain(notHiddenFromViewerSql('$2', '"member"."user_id"'));
    });

    it('requires an active account, an open profile, no self-hide and no takedown for every viewer', async () => {
      for (const viewer of [
        { isActiveMember: false, userId: null },
        { isActiveMember: false, userId: 'viewer-1' },
        { isActiveMember: true, userId: 'viewer-1' },
      ]) {
        manager.query.mockClear();
        await load(viewer);
        const { sql } = teamQuery();
        expect(sql).toContain(`"member_user"."status" = 'active'`);
        expect(sql).toContain(`"member_profile"."visibility" = 'open'`);
        expect(sql).toContain('"member_profile"."hidden_until"');
        expect(sql).toContain(
          '"member_profile_moderation"."subject_type" = \'member\'',
        );
      }
    });

    it('applies LIMIT 40 in the same query after the eligibility filter and the ordering', async () => {
      await load({ isActiveMember: false, userId: null });

      expect(manager.query).toHaveBeenCalledTimes(1);
      const { sql } = teamQuery();
      const whereIndex = sql.indexOf('WHERE');
      const eligibilityIndex = sql.indexOf(
        eligibleMemberSql('member_profile', 'member_user'),
      );
      const orderIndex = sql.indexOf(
        'ORDER BY "member"."position" ASC, "member"."id" ASC',
      );
      const limitIndex = sql.indexOf('LIMIT 40');
      expect(whereIndex).toBeGreaterThan(-1);
      expect(eligibilityIndex).toBeGreaterThan(whereIndex);
      expect(orderIndex).toBeGreaterThan(eligibilityIndex);
      expect(limitIndex).toBeGreaterThan(orderIndex);
      expect(sql.match(/LIMIT/g)).toHaveLength(1);
    });

    it('merges personas and members in the order the SQL gave, with kind set', async () => {
      manager.query.mockResolvedValue([
        memberRow('user-ana', 'Owner'),
        personaRow('persona-1', 'Bartender'),
        memberRow('user-rui', null),
      ]);
      manager.find
        .mockResolvedValueOnce([{ ...makePersona(), userId: 'owner-1' }])
        .mockResolvedValueOnce([
          makeMemberProfile({ userId: 'user-rui', slug: 'rui-mendes' }),
          makeMemberProfile(),
        ]);

      const team = await load({ isActiveMember: true, userId: 'viewer-1' });

      expect(team.map((entry) => [entry.kind, entry.roleLabel])).toEqual([
        ['member', 'Owner'],
        ['persona', 'Bartender'],
        ['member', null],
      ]);
      expect(subjectsOf(team)).toEqual(['ana-silva', 'ink-ana', 'rui-mendes']);
      expect(manager.find).toHaveBeenCalledTimes(2);
      expect(mediaCropService.getMany).toHaveBeenCalledTimes(1);
      expect(mediaCropService.getMany).toHaveBeenCalledWith([
        'uploads/ink-ana.jpg',
        'uploads/ana.jpg',
        'uploads/ana.jpg',
      ]);
    });

    it('shapes a member entry with the name, slug and the cropped avatar', async () => {
      manager.query.mockResolvedValue([memberRow('user-ana', null)]);
      manager.find.mockResolvedValueOnce([makeMemberProfile()]);
      mediaCropService.getMany.mockResolvedValue(
        new Map([['uploads/ana.jpg', { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }]]),
      );

      const entry = entryOf(
        await load({ isActiveMember: false, userId: null }),
      );

      expect(entry).toMatchObject({
        kind: 'member',
        roleLabel: null,
        member: { slug: 'ana-silva', name: 'Ana Silva' },
      });
      expect(memberOf(entry).avatarUrl).toEqual(
        expect.stringContaining('uploads/ana.jpg'),
      );
      expect(memberOf(entry).avatarCrop).toBeDefined();
    });

    it('gives a null avatar, no crop and no crop lookup key when the member hid their photo', async () => {
      manager.query.mockResolvedValue([memberRow('user-ana', null)]);
      manager.find.mockResolvedValueOnce([
        makeMemberProfile({ photoVisible: false }),
      ]);

      const entry = entryOf(
        await load({ isActiveMember: false, userId: null }),
      );

      expect(memberOf(entry).avatarUrl).toBeNull();
      expect(memberOf(entry)).not.toHaveProperty('avatarCrop');
      expect(mediaCropService.getMany).toHaveBeenCalledWith([]);
    });

    it('queries the persona columns only when a persona is on the team and the member columns only when a member is', async () => {
      manager.query.mockResolvedValue([memberRow('user-ana', null)]);
      manager.find.mockResolvedValueOnce([makeMemberProfile()]);
      await load({ isActiveMember: false, userId: null });

      expect(manager.find).toHaveBeenCalledTimes(1);
      expect(firstFindEntity(manager.find)).toBe(Profile);

      manager.find.mockClear();
      manager.query.mockResolvedValue([personaRow('persona-1', null)]);
      manager.find.mockResolvedValueOnce([
        { ...makePersona(), userId: 'owner-1' },
      ]);
      await load({ isActiveMember: false, userId: null });

      expect(manager.find).toHaveBeenCalledTimes(1);
      expect(firstFindEntity(manager.find)).not.toBe(Profile);
    });

    it('skips a member entry whose profile row is missing and keeps the rest in order', async () => {
      manager.query.mockResolvedValue([
        memberRow('user-gone', null),
        memberRow('user-ana', 'Chef'),
      ]);
      manager.find.mockResolvedValueOnce([makeMemberProfile()]);

      const team = await load({ isActiveMember: false, userId: null });

      expect(subjectsOf(team)).toEqual(['ana-silva']);
    });

    it('carries no user id on any entry', async () => {
      manager.query.mockResolvedValue([
        memberRow('user-ana', null),
        personaRow('persona-1', null),
      ]);
      manager.find
        .mockResolvedValueOnce([{ ...makePersona(), userId: 'owner-1' }])
        .mockResolvedValueOnce([makeMemberProfile()]);

      const team = await load({ isActiveMember: true, userId: 'viewer-1' });

      const wire = JSON.stringify(team);
      expect(wire).not.toContain('user-ana');
      expect(wire).not.toContain('owner-1');
      expect(wire).not.toContain('viewer-1');
      expect(wire).not.toMatch(/user_?id/i);
    });
  });
});

describe('DirectoryController.getDirectoryListing viewer', () => {
  it('passes the viewer id from the controller and null for an anonymous caller', async () => {
    const directoryService = {
      getDirectoryBySlug: jest.fn().mockResolvedValue({}),
    };
    const controller = new DirectoryController(
      directoryService as never,
      {} as never,
    );

    await controller.getDirectoryListing(undefined, 'casa-t');
    expect(directoryService.getDirectoryBySlug).toHaveBeenLastCalledWith(
      'casa-t',
      false,
      null,
    );

    await controller.getDirectoryListing(
      {
        userId: 'user-1',
        email: 'member@example.com',
        status: UserStatus.Active,
        role: 'member',
      },
      'casa-t',
    );
    expect(directoryService.getDirectoryBySlug).toHaveBeenLastCalledWith(
      'casa-t',
      true,
      'user-1',
    );
  });
});

import type { EntityManager } from 'typeorm';
import type { MediaCropService } from '../media-crops/media-crops.service';
import { SubprofileKind } from '../subprofiles/entities/subprofile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { DirectoryController } from './directory.controller';
import {
  loadPublicTeam,
  type ListingTeamViewer,
} from './listing-team-public-team';
import type { ListingTeamPersonaColumns } from './listing-team-response';
import {
  anonymousVisiblePersonaSql,
  eligiblePersonaSql,
  notBlockedEitherWaySql,
} from './listing-team-visibility';

const LISTING_ID = 'listing-1';

function makePersona(
  overrides: Partial<ListingTeamPersonaColumns> = {},
): ListingTeamPersonaColumns {
  return {
    id: 'persona-1',
    handle: 'ink-ana',
    displayName: 'Ink Ana',
    kind: SubprofileKind.Musician,
    avatarUrl: 'uploads/ink-ana.jpg',
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
      { subprofile_id: 'persona-2', role_label: 'Bartender' },
      { subprofile_id: 'persona-1', role_label: null },
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

    expect(
      team.map((member) => [member.persona.handle, member.roleLabel]),
    ).toEqual([
      ['rui-sound', 'Bartender'],
      ['ink-ana', null],
    ]);
    expect(mediaCropService.getMany).toHaveBeenCalledTimes(1);
    expect(mediaCropService.getMany).toHaveBeenCalledWith([
      'uploads/ink-ana.jpg',
    ]);
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

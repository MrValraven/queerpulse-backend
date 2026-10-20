import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  assertCommunityBoardReadable,
  assertCommunityInteriorReadable,
} from './community-read-gate';
import { RosterRole } from './entities/community-member.entity';
import { AccessTier, Community } from './entities/community.entity';

const VISIBLE = { hidden: false, removed: false };

// A live top-level community, fully visible and unarchived.
const LIVE_COMMUNITY: Pick<Community, 'slug' | 'archivedAt' | 'parentId'> = {
  slug: 'queer-devs',
  archivedAt: null,
  parentId: null,
};

describe('assertCommunityInteriorReadable', () => {
  let communities: { findOne: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };

  beforeEach(() => {
    communities = { findOne: jest.fn().mockResolvedValue(null) };
    contentModeration = { stateFor: jest.fn().mockResolvedValue(VISIBLE) };
  });

  const run = (input: {
    community: Pick<Community, 'slug' | 'archivedAt' | 'parentId'>;
    viewerRole: RosterRole | null;
  }) =>
    assertCommunityInteriorReadable({
      ...input,
      communities: communities as unknown as Repository<Community>,
      contentModeration: contentModeration,
    });

  it('404s a hidden community to a plain member', async () => {
    contentModeration.stateFor.mockResolvedValue({
      hidden: true,
      removed: false,
    });
    await expect(
      run({ community: LIVE_COMMUNITY, viewerRole: RosterRole.Member }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets community staff read a hidden community', async () => {
    contentModeration.stateFor.mockResolvedValue({
      hidden: true,
      removed: false,
    });
    await expect(
      run({ community: LIVE_COMMUNITY, viewerRole: RosterRole.Mod }),
    ).resolves.toBeUndefined();
  });

  it('404s an archived community to a non-member', async () => {
    const archivedCommunity = {
      ...LIVE_COMMUNITY,
      archivedAt: new Date('2026-01-06T00:00:00.000Z'),
    };
    await expect(
      run({ community: archivedCommunity, viewerRole: null }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets the roster read an archived community', async () => {
    const archivedCommunity = {
      ...LIVE_COMMUNITY,
      archivedAt: new Date('2026-01-06T00:00:00.000Z'),
    };
    await expect(
      run({ community: archivedCommunity, viewerRole: RosterRole.Member }),
    ).resolves.toBeUndefined();
  });

  it('404s a space under an archived parent to a non-member', async () => {
    const space = {
      ...LIVE_COMMUNITY,
      slug: 'queer-devs-parents',
      parentId: 'c1',
    };
    communities.findOne.mockResolvedValue({
      id: 'c1',
      slug: 'queer-devs',
      archivedAt: new Date('2026-01-06T00:00:00.000Z'),
    });
    await expect(
      run({ community: space, viewerRole: null }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(communities.findOne).toHaveBeenCalledWith({
      where: { id: 'c1' },
    });
  });

  it('lets a non-member read a live public community', async () => {
    await expect(
      run({ community: LIVE_COMMUNITY, viewerRole: null }),
    ).resolves.toBeUndefined();
  });
});

describe('assertCommunityBoardReadable', () => {
  let communities: { findOne: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };

  type BoardCommunity = Pick<
    Community,
    'slug' | 'archivedAt' | 'parentId' | 'accessTier'
  >;

  const PUBLIC_COMMUNITY: BoardCommunity = {
    ...LIVE_COMMUNITY,
    accessTier: AccessTier.Public,
  };

  beforeEach(() => {
    communities = { findOne: jest.fn().mockResolvedValue(null) };
    contentModeration = { stateFor: jest.fn().mockResolvedValue(VISIBLE) };
  });

  const run = (input: {
    community: BoardCommunity;
    viewerRole: RosterRole | null;
  }) =>
    assertCommunityBoardReadable({
      ...input,
      communities: communities as unknown as Repository<Community>,
      contentModeration: contentModeration,
    });

  it('serves a public community to a viewer with no role', async () => {
    await expect(
      run({ community: PUBLIC_COMMUNITY, viewerRole: null }),
    ).resolves.toBeUndefined();
  });

  it('refuses a request-tier non-member with COMMUNITY_MEMBERS_ONLY', async () => {
    const requestCommunity = {
      ...PUBLIC_COMMUNITY,
      accessTier: AccessTier.Request,
    };
    const refusal = await run({
      community: requestCommunity,
      viewerRole: null,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect((refusal as ForbiddenException).getResponse()).toEqual(
      expect.objectContaining({ code: 'COMMUNITY_MEMBERS_ONLY' }),
    );
  });

  it('refuses an invite-tier non-member with 403', async () => {
    const inviteCommunity = {
      ...PUBLIC_COMMUNITY,
      accessTier: AccessTier.Invite,
    };
    await expect(
      run({ community: inviteCommunity, viewerRole: null }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('404s a private-tier non-member', async () => {
    const privateCommunity = {
      ...PUBLIC_COMMUNITY,
      accessTier: AccessTier.Private,
    };
    await expect(
      run({ community: privateCommunity, viewerRole: null }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('serves a gated community to a plain member', async () => {
    const inviteCommunity = {
      ...PUBLIC_COMMUNITY,
      accessTier: AccessTier.Invite,
    };
    await expect(
      run({ community: inviteCommunity, viewerRole: RosterRole.Member }),
    ).resolves.toBeUndefined();
  });

  it('404s a member of a taken-down community but serves its moderator', async () => {
    contentModeration.stateFor.mockResolvedValue({
      hidden: true,
      removed: false,
    });
    await expect(
      run({ community: PUBLIC_COMMUNITY, viewerRole: RosterRole.Member }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      run({ community: PUBLIC_COMMUNITY, viewerRole: RosterRole.Mod }),
    ).resolves.toBeUndefined();
  });

  it('404s a public space whose parent is gone to a viewer with no role', async () => {
    const space = {
      ...PUBLIC_COMMUNITY,
      slug: 'queer-devs-parents',
      parentId: 'c1',
    };
    await expect(
      run({ community: space, viewerRole: null }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

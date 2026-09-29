import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { assertCommunityInteriorReadable } from './community-read-gate';
import { RosterRole } from './entities/community-member.entity';
import { Community } from './entities/community.entity';

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

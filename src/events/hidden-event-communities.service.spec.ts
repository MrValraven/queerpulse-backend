import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  CommunityMembershipService,
  CommunityTierRef,
} from '../communities/community-membership.service';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { RosterRole } from '../communities/entities/community-member.entity';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { HiddenEventCommunity } from './entities/hidden-event-community.entity';
import {
  HIDDEN_EVENT_COMMUNITIES_LIMIT,
  HiddenEventCommunitiesService,
} from './hidden-event-communities.service';

/** Chainable insert-builder stub for the `orIgnore()` insert path. */
interface InsertBuilderStub {
  insert: jest.Mock<InsertBuilderStub, unknown[]>;
  into: jest.Mock<InsertBuilderStub, unknown[]>;
  values: jest.Mock<InsertBuilderStub, unknown[]>;
  orIgnore: jest.Mock<InsertBuilderStub, unknown[]>;
  execute: jest.Mock<Promise<unknown>, []>;
}

function insertBuilderStub(): InsertBuilderStub {
  const builder: InsertBuilderStub = {
    insert: jest.fn<InsertBuilderStub, unknown[]>(),
    into: jest.fn<InsertBuilderStub, unknown[]>(),
    values: jest.fn<InsertBuilderStub, unknown[]>(),
    orIgnore: jest.fn<InsertBuilderStub, unknown[]>(),
    execute: jest.fn<Promise<unknown>, []>(),
  };
  builder.insert.mockReturnValue(builder);
  builder.into.mockReturnValue(builder);
  builder.values.mockReturnValue(builder);
  builder.orIgnore.mockReturnValue(builder);
  builder.execute.mockResolvedValue({});
  return builder;
}

const NOT_FOUND_BODY = {
  code: 'HIDDEN_COMMUNITY_NOT_FOUND',
  message: 'No community with that name is visible to you.',
};

describe('HiddenEventCommunitiesService', () => {
  let service: HiddenEventCommunitiesService;
  let hiddenCommunities: {
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let communities: { findOne: jest.Mock };
  let membership: { effectiveRole: jest.Mock; tierRefsByIds: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };
  let builder: InsertBuilderStub;

  const communityRow = (overrides: Partial<Community> = {}): Community =>
    ({
      id: 'community-1',
      parentId: null,
      slug: 'queer-runners',
      name: 'Queer Runners Lisboa',
      accessTier: AccessTier.Public,
      avatarImageUrl: null,
      archivedAt: null,
      ...overrides,
    }) as Community;

  const hiddenRow = (
    overrides: Partial<HiddenEventCommunity> = {},
  ): HiddenEventCommunity => ({
    id: 'hidden-1',
    userId: 'viewer-1',
    communityId: 'community-1',
    createdAt: new Date('2026-10-20T10:00:00.000Z'),
    ...overrides,
  });

  const tierRef = (
    overrides: Partial<CommunityTierRef> = {},
  ): CommunityTierRef => ({
    id: 'community-1',
    parentId: null,
    slug: 'queer-runners',
    name: 'Queer Runners Lisboa',
    accessTier: AccessTier.Public,
    avatarImageUrl: null,
    ...overrides,
  });

  beforeEach(async () => {
    builder = insertBuilderStub();
    hiddenCommunities = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      createQueryBuilder: jest.fn(() => builder),
    };
    communities = { findOne: jest.fn().mockResolvedValue(communityRow()) };
    membership = {
      effectiveRole: jest.fn().mockResolvedValue(null),
      tierRefsByIds: jest.fn().mockResolvedValue(new Map()),
    };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HiddenEventCommunitiesService,
        {
          provide: getRepositoryToken(HiddenEventCommunity),
          useValue: hiddenCommunities,
        },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: CommunityMembershipService, useValue: membership },
        { provide: ContentModerationService, useValue: contentModeration },
      ],
    }).compile();
    service = module.get(HiddenEventCommunitiesService);
  });

  describe('hide', () => {
    it('answers 404 with HIDDEN_COMMUNITY_NOT_FOUND for an unknown slug', async () => {
      communities.findOne.mockResolvedValue(null);

      const failure = await service
        .hide('viewer-1', 'nowhere')
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(NotFoundException);
      expect((failure as NotFoundException).getResponse()).toEqual(
        NOT_FOUND_BODY,
      );
      expect(builder.execute).not.toHaveBeenCalled();
    });

    it('answers the same 404 body for a private community the viewer holds no role in', async () => {
      communities.findOne.mockResolvedValue(
        communityRow({ accessTier: AccessTier.Private }),
      );
      membership.effectiveRole.mockResolvedValue(null);

      const failure = await service
        .hide('viewer-1', 'queer-runners')
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(NotFoundException);
      expect((failure as NotFoundException).getResponse()).toEqual(
        NOT_FOUND_BODY,
      );
      expect(builder.execute).not.toHaveBeenCalled();
    });

    it('answers the same 404 body for an archived community the viewer holds no role in', async () => {
      communities.findOne.mockResolvedValue(
        communityRow({ archivedAt: new Date('2026-10-01T00:00:00.000Z') }),
      );

      const failure = await service
        .hide('viewer-1', 'queer-runners')
        .catch((error: unknown) => error);

      expect((failure as NotFoundException).getResponse()).toEqual(
        NOT_FOUND_BODY,
      );
    });

    it('hides a private community the viewer holds a role in', async () => {
      communities.findOne.mockResolvedValue(
        communityRow({ accessTier: AccessTier.Private }),
      );
      membership.effectiveRole.mockResolvedValue(RosterRole.Member);
      hiddenCommunities.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(hiddenRow());

      await expect(service.hide('viewer-1', 'queer-runners')).resolves.toEqual({
        communityId: 'community-1',
        slug: 'queer-runners',
        name: 'Queer Runners Lisboa',
        avatarImageUrl: null,
        hiddenAt: '2026-10-20T10:00:00.000Z',
      });
      expect(builder.orIgnore).toHaveBeenCalled();
      expect(builder.values).toHaveBeenCalledWith({
        userId: 'viewer-1',
        communityId: 'community-1',
      });
    });

    it('hides a public community for a viewer off its roster', async () => {
      hiddenCommunities.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(hiddenRow());

      await service.hide('viewer-1', 'queer-runners');

      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'community',
        'queer-runners',
      );
      expect(builder.into).toHaveBeenCalledWith(HiddenEventCommunity);
    });

    it('hides an archived community for a viewer on its roster', async () => {
      communities.findOne.mockResolvedValue(
        communityRow({ archivedAt: new Date('2026-10-01T00:00:00.000Z') }),
      );
      membership.effectiveRole.mockResolvedValue(RosterRole.Member);
      hiddenCommunities.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(hiddenRow());

      await expect(
        service.hide('viewer-1', 'queer-runners'),
      ).resolves.toMatchObject({ communityId: 'community-1' });
      expect(builder.execute).toHaveBeenCalled();
    });

    it('answers the same 404 body for a public community a moderator removed', async () => {
      contentModeration.stateFor.mockResolvedValue({
        hidden: false,
        removed: true,
      });

      const failure = await service
        .hide('viewer-1', 'queer-runners')
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(NotFoundException);
      expect((failure as NotFoundException).getResponse()).toEqual(
        NOT_FOUND_BODY,
      );
      expect(builder.execute).not.toHaveBeenCalled();
    });

    it('answers the same 404 body for a moderated community to a plain roster member', async () => {
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });
      membership.effectiveRole.mockResolvedValue(RosterRole.Member);

      const failure = await service
        .hide('viewer-1', 'queer-runners')
        .catch((error: unknown) => error);

      expect((failure as NotFoundException).getResponse()).toEqual(
        NOT_FOUND_BODY,
      );
    });

    it('hides a moderator-removed community for its own staff', async () => {
      contentModeration.stateFor.mockResolvedValue({
        hidden: false,
        removed: true,
      });
      membership.effectiveRole.mockResolvedValue(RosterRole.Mod);
      hiddenCommunities.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(hiddenRow());

      await expect(
        service.hide('viewer-1', 'queer-runners'),
      ).resolves.toMatchObject({ communityId: 'community-1' });
      expect(builder.execute).toHaveBeenCalled();
    });

    it('answers the same 404 body for a space whose parent is archived', async () => {
      const parentRow = communityRow({
        id: 'parent-1',
        slug: 'parent-community',
        archivedAt: new Date('2026-10-01T00:00:00.000Z'),
      });
      communities.findOne.mockImplementation(
        (options: { where: { slug?: string; id?: string } }) =>
          Promise.resolve(
            options.where.id === 'parent-1'
              ? parentRow
              : communityRow({ parentId: 'parent-1' }),
          ),
      );

      const failure = await service
        .hide('viewer-1', 'queer-runners')
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(NotFoundException);
      expect((failure as NotFoundException).getResponse()).toEqual(
        NOT_FOUND_BODY,
      );
      expect(communities.findOne).toHaveBeenCalledWith({
        where: { id: 'parent-1' },
      });
      expect(builder.execute).not.toHaveBeenCalled();
    });

    it('returns an existing row as is without counting or inserting', async () => {
      hiddenCommunities.findOne.mockResolvedValue(
        hiddenRow({ createdAt: new Date('2026-09-01T08:00:00.000Z') }),
      );

      await expect(
        service.hide('viewer-1', 'queer-runners'),
      ).resolves.toMatchObject({
        communityId: 'community-1',
        hiddenAt: '2026-09-01T08:00:00.000Z',
      });
      expect(hiddenCommunities.count).not.toHaveBeenCalled();
      expect(builder.execute).not.toHaveBeenCalled();
    });

    it('answers 409 with HIDDEN_COMMUNITIES_LIMIT_REACHED and the limit at 200 rows', async () => {
      hiddenCommunities.count.mockResolvedValue(HIDDEN_EVENT_COMMUNITIES_LIMIT);

      const failure = await service
        .hide('viewer-1', 'queer-runners')
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConflictException);
      expect((failure as ConflictException).getResponse()).toEqual({
        code: 'HIDDEN_COMMUNITIES_LIMIT_REACHED',
        message: 'You can hide events from up to 200 communities.',
        limit: 200,
      });
      expect(hiddenCommunities.count).toHaveBeenCalledWith({
        where: { userId: 'viewer-1' },
      });
      expect(builder.execute).not.toHaveBeenCalled();
    });
  });

  describe('unhide', () => {
    it('resolves { hidden: false } when no row existed', async () => {
      hiddenCommunities.delete.mockResolvedValue({ affected: 0 });

      await expect(service.unhide('viewer-1', 'community-1')).resolves.toEqual({
        hidden: false,
      });
      expect(hiddenCommunities.delete).toHaveBeenCalledWith({
        userId: 'viewer-1',
        communityId: 'community-1',
      });
    });
  });

  describe('list', () => {
    it('lists newest first, drops a row tierRefsByIds cannot name, and reads refs once', async () => {
      hiddenCommunities.find.mockResolvedValue([
        hiddenRow({
          id: 'hidden-2',
          communityId: 'community-2',
          createdAt: new Date('2026-10-22T10:00:00.000Z'),
        }),
        hiddenRow({ id: 'hidden-gone', communityId: 'community-gone' }),
        hiddenRow(),
      ]);
      membership.tierRefsByIds.mockResolvedValue(
        new Map([
          [
            'community-2',
            tierRef({
              id: 'community-2',
              slug: 'trans-hub',
              name: 'Trans & Non-Binary Hub',
              avatarImageUrl: 'https://cdn.example/trans-hub.png',
            }),
          ],
          ['community-1', tierRef()],
        ]),
      );

      await expect(service.list('viewer-1')).resolves.toEqual([
        {
          communityId: 'community-2',
          slug: 'trans-hub',
          name: 'Trans & Non-Binary Hub',
          avatarImageUrl: 'https://cdn.example/trans-hub.png',
          hiddenAt: '2026-10-22T10:00:00.000Z',
        },
        {
          communityId: 'community-1',
          slug: 'queer-runners',
          name: 'Queer Runners Lisboa',
          avatarImageUrl: null,
          hiddenAt: '2026-10-20T10:00:00.000Z',
        },
      ]);
      expect(hiddenCommunities.find).toHaveBeenCalledWith({
        where: { userId: 'viewer-1' },
        order: { createdAt: 'DESC' },
      });
      expect(membership.tierRefsByIds).toHaveBeenCalledTimes(1);
      expect(membership.tierRefsByIds).toHaveBeenCalledWith([
        'community-2',
        'community-gone',
        'community-1',
      ]);
    });

    it('returns an empty list without reading refs when nothing is hidden', async () => {
      await expect(service.list('viewer-1')).resolves.toEqual([]);
      expect(membership.tierRefsByIds).not.toHaveBeenCalled();
    });
  });
});

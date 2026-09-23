import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { CommunitiesService } from './communities.service';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import { CommunityMembershipService } from './community-membership.service';
import { CreateSubcommunityDto } from './dto/create-subcommunity.dto';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityPost } from './entities/community-post.entity';
import {
  AccessTier,
  Community,
  CommunityType,
} from './entities/community.entity';
import { SubcommunitiesService } from './subcommunities.service';
import {
  SUBCOMMUNITIES_NOT_ALLOWED_CODE,
  SUBCOMMUNITY_TIER_TOO_OPEN_CODE,
} from './subcommunity-rules';

const ACTOR_ID = 'actor-1';

const PARENT = {
  id: 'parent-1',
  slug: 'queer-devs',
  parentId: null,
  allowsSubcommunities: true,
  accessTier: AccessTier.Request,
  type: CommunityType.Professional,
  whoFor: 'Queer people who write software',
  city: 'Lisbon',
  area: 'Arroios',
  isOnline: true,
  languages: ['pt', 'en'],
  tags: ['tech'],
} as unknown as Community;

const DTO: CreateSubcommunityDto = {
  handle: 'Rust Circle',
  name: 'Rust circle',
  tagline: 'Rustaceans',
  purpose: 'Pair on Rust',
  accessTier: AccessTier.Invite,
  rules: ['Be kind to beginners'],
};

const DETAIL = { slug: 'rust-circle' };

const space = (overrides: Partial<Community>): Community =>
  ({
    id: 'space-x',
    slug: 'space-x',
    name: 'Space',
    parentId: PARENT.id,
    accessTier: AccessTier.Request,
    archivedAt: null,
    activeThisWeek: 0,
    tags: [],
    languages: [],
    coverImageUrl: null,
    avatarImageUrl: null,
    ...overrides,
  }) as unknown as Community;

const groupedCountStub = (rows: { communityId: string; count: string }[]) => {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
  ]) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawMany = jest.fn().mockResolvedValue(rows);
  return queryBuilder;
};

// The batched resolver's answer: effective roles plus the ids where the
// viewer holds their own roster row.
function rolesResult(
  rolesByCommunityId: Map<string, RosterRole>,
  ownRosterIds: string[] = [],
): {
  rolesByCommunityId: Map<string, RosterRole>;
  ownRosterCommunityIds: Set<string>;
} {
  return { rolesByCommunityId, ownRosterCommunityIds: new Set(ownRosterIds) };
}

describe('SubcommunitiesService', () => {
  let service: SubcommunitiesService;
  let communities: {
    findOne: jest.Mock;
    find: jest.Mock;
    exists: jest.Mock;
  };
  let members: { createQueryBuilder: jest.Mock };
  let posts: { createQueryBuilder: jest.Mock };
  let communitiesService: { getBySlug: jest.Mock };
  let membership: {
    assertOwnerOrModBySlug: jest.Mock;
    effectiveRolesAndOwnRowsFor: jest.Mock;
  };
  let governanceLog: { log: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let contentModeration: { stateFor: jest.Mock; statesFor: jest.Mock };
  // What the create transaction writes, by repository.
  let spaceRepository: { create: jest.Mock; save: jest.Mock };
  let memberRepository: { create: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    communities = {
      findOne: jest.fn().mockResolvedValue(PARENT),
      find: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(false),
    };
    members = { createQueryBuilder: jest.fn(() => groupedCountStub([])) };
    posts = { createQueryBuilder: jest.fn(() => groupedCountStub([])) };
    communitiesService = { getBySlug: jest.fn().mockResolvedValue(DETAIL) };
    membership = {
      assertOwnerOrModBySlug: jest.fn().mockResolvedValue(PARENT.id),
      effectiveRolesAndOwnRowsFor: jest
        .fn()
        .mockResolvedValue(rolesResult(new Map())),
    };
    governanceLog = { log: jest.fn().mockResolvedValue(undefined) };
    eventEmitter = { emit: jest.fn() };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
      statesFor: jest.fn().mockResolvedValue(new Map()),
    };
    spaceRepository = {
      create: jest.fn((row: Partial<Community>) => row),
      save: jest.fn((row: Partial<Community>) =>
        Promise.resolve({ ...row, id: 'space-new', rulesVersion: 1 }),
      ),
    };
    memberRepository = {
      create: jest.fn((row: Partial<CommunityMember>) => row),
      save: jest.fn((row: Partial<CommunityMember>) => Promise.resolve(row)),
    };
    const manager = {
      query: jest.fn().mockResolvedValue([{ refNumber: '42' }]),
      getRepository: jest.fn((entity: unknown) =>
        entity === Community ? spaceRepository : memberRepository,
      ),
    };
    const dataSource = {
      transaction: jest.fn(
        (callback: (transactionManager: unknown) => Promise<unknown>) =>
          callback(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubcommunitiesService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        { provide: getRepositoryToken(CommunityPost), useValue: posts },
        { provide: DataSource, useValue: dataSource },
        { provide: CommunitiesService, useValue: communitiesService },
        { provide: CommunityMembershipService, useValue: membership },
        { provide: CommunityGovernanceLogService, useValue: governanceLog },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: ContentModerationService, useValue: contentModeration },
      ],
    }).compile();
    service = module.get(SubcommunitiesService);
  });

  describe('create', () => {
    it('inserts a space under the parent with the inherited fields and an owner row', async () => {
      await expect(service.create(PARENT.slug, ACTOR_ID, DTO)).resolves.toBe(
        DETAIL,
      );

      expect(spaceRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'rust-circle',
          parentId: PARENT.id,
          accessTier: AccessTier.Invite,
          type: PARENT.type,
          city: PARENT.city,
          area: PARENT.area,
          isOnline: PARENT.isOnline,
          languages: PARENT.languages,
          tags: PARENT.tags,
          whoFor: PARENT.whoFor,
          isPubliclyListed: false,
          isFeatured: false,
          rosterVisible: true,
          features: ['discussion', 'events', 'library', 'roster'],
          ownerId: ACTOR_ID,
          ref: 'QP-C-0042',
        }),
      );
      expect(memberRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 'space-new',
          userId: ACTOR_ID,
          role: RosterRole.Owner,
          rulesVersionAccepted: 1,
          rulesAcceptedAt: expect.any(Date) as unknown,
        }),
      );
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: PARENT.id,
          actorUserId: ACTOR_ID,
          action: GovernanceLogAction.SubcommunityCreated,
          metadata: { spaceId: 'space-new' },
        }),
      );
      expect(communitiesService.getBySlug).toHaveBeenCalledWith(
        'rust-circle',
        ACTOR_ID,
      );
    });

    it('refuses with 409 when the parent does not allow spaces', async () => {
      communities.findOne.mockResolvedValue({
        ...PARENT,
        allowsSubcommunities: false,
      });

      const failure = service.create(PARENT.slug, ACTOR_ID, DTO);

      await expect(failure).rejects.toBeInstanceOf(ConflictException);
      await expect(failure).rejects.toMatchObject({
        response: { code: SUBCOMMUNITIES_NOT_ALLOWED_CODE },
      });
      expect(spaceRepository.save).not.toHaveBeenCalled();
    });

    it('refuses with 409 when the parent is itself a space', async () => {
      communities.findOne.mockResolvedValue({
        ...PARENT,
        parentId: 'grandparent-1',
      });

      await expect(
        service.create(PARENT.slug, ACTOR_ID, DTO),
      ).rejects.toMatchObject({
        response: { code: SUBCOMMUNITIES_NOT_ALLOWED_CODE },
      });
      expect(spaceRepository.save).not.toHaveBeenCalled();
    });

    it('refuses with 400 a tier more open than the parent', async () => {
      const failure = service.create(PARENT.slug, ACTOR_ID, {
        ...DTO,
        accessTier: AccessTier.Public,
      });

      await expect(failure).rejects.toBeInstanceOf(BadRequestException);
      await expect(failure).rejects.toMatchObject({
        response: { code: SUBCOMMUNITY_TIER_TOO_OPEN_CODE },
      });
      expect(spaceRepository.save).not.toHaveBeenCalled();
    });

    it('refuses with 403 under a frozen parent', async () => {
      communities.findOne.mockResolvedValue({
        ...PARENT,
        frozenAt: new Date(),
      });

      await expect(
        service.create(PARENT.slug, ACTOR_ID, DTO),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(spaceRepository.save).not.toHaveBeenCalled();
    });

    it('refuses with 403 under a parent taken down by a moderator', async () => {
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(
        service.create(PARENT.slug, ACTOR_ID, DTO),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'community',
        PARENT.slug,
      );
      expect(spaceRepository.save).not.toHaveBeenCalled();
    });

    it('refuses with 403 a plain parent member', async () => {
      membership.assertOwnerOrModBySlug.mockRejectedValue(
        new ForbiddenException(
          'Only the community owner or a moderator can do that',
        ),
      );

      await expect(
        service.create(PARENT.slug, ACTOR_ID, DTO),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(spaceRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('marks a card joined only off the viewer own space roster row', async () => {
      communities.findOne.mockResolvedValue({ id: PARENT.id });
      communities.find.mockResolvedValue([
        space({ id: 'space-a', slug: 'a', accessTier: AccessTier.Request }),
        space({ id: 'space-b', slug: 'b', accessTier: AccessTier.Request }),
      ]);
      // Parent mod: an inherited role in both, a roster row in `a` only.
      membership.effectiveRolesAndOwnRowsFor.mockResolvedValue(
        rolesResult(
          new Map([
            ['space-a', RosterRole.Mod],
            ['space-b', RosterRole.Mod],
          ]),
          ['space-a'],
        ),
      );

      const cards = await service.list(PARENT.slug, ACTOR_ID);

      expect(
        cards.map((card) => [card.slug, card.myRole, card.isMember]),
      ).toEqual([
        ['a', RosterRole.Mod, true],
        ['b', RosterRole.Mod, false],
      ]);
    });

    const openSpace = space({
      id: 'space-open',
      slug: 'open',
      accessTier: AccessTier.Request,
    });
    const privateSpace = space({
      id: 'space-private',
      slug: 'hidden',
      accessTier: AccessTier.Private,
    });

    beforeEach(() => {
      communities.findOne.mockResolvedValue({ id: PARENT.id });
      communities.find.mockResolvedValue([openSpace, privateSpace]);
    });

    it('asks only for live spaces of the parent', async () => {
      await service.list(PARENT.slug, ACTOR_ID);

      expect(communities.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { parentId: PARENT.id, archivedAt: IsNull() },
        }),
      );
    });

    it('hides a private space from a parent member outside it', async () => {
      membership.effectiveRolesAndOwnRowsFor.mockResolvedValue(
        rolesResult(new Map()),
      );

      const cards = await service.list(PARENT.slug, ACTOR_ID);

      expect(cards.map((card) => card.slug)).toEqual(['open']);
    });

    it('shows a private space to a parent mod through the inherited role', async () => {
      membership.effectiveRolesAndOwnRowsFor.mockResolvedValue(
        rolesResult(
          new Map([
            ['space-open', RosterRole.Mod],
            ['space-private', RosterRole.Mod],
          ]),
        ),
      );
      members.createQueryBuilder.mockReturnValue(
        groupedCountStub([{ communityId: 'space-private', count: '4' }]),
      );

      const cards = await service.list(PARENT.slug, ACTOR_ID);

      expect(cards.map((card) => card.slug)).toEqual(['open', 'hidden']);
      const hiddenCard = cards.find((card) => card.slug === 'hidden');
      expect(hiddenCard?.myRole).toBe(RosterRole.Mod);
      expect(hiddenCard?.memberCount).toBe(4);
    });

    it('hides a space under a moderator takedown from a parent member', async () => {
      membership.effectiveRolesAndOwnRowsFor.mockResolvedValue(
        rolesResult(new Map([['space-open', RosterRole.Member]])),
      );
      contentModeration.statesFor.mockResolvedValue(
        new Map([['open', { hidden: false, removed: true }]]),
      );

      const cards = await service.list(PARENT.slug, ACTOR_ID);

      expect(contentModeration.statesFor).toHaveBeenCalledTimes(1);
      expect(contentModeration.statesFor).toHaveBeenCalledWith('community', [
        'open',
        'hidden',
      ]);
      expect(cards).toEqual([]);
    });

    it('keeps a taken-down space visible to parent staff', async () => {
      membership.effectiveRolesAndOwnRowsFor.mockResolvedValue(
        rolesResult(new Map([['space-open', RosterRole.CoOwner]])),
      );
      contentModeration.statesFor.mockResolvedValue(
        new Map([['open', { hidden: true, removed: false }]]),
      );

      const cards = await service.list(PARENT.slug, ACTOR_ID);

      expect(cards.map((card) => card.slug)).toEqual(['open']);
    });

    it("answers the parent's own 404 when the viewer cannot see it", async () => {
      communitiesService.getBySlug.mockRejectedValue(
        new NotFoundException('Community not found'),
      );

      await expect(service.list(PARENT.slug, ACTOR_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(communities.find).not.toHaveBeenCalled();
    });

    it("answers the parent's own 403 when the parent is closed to the viewer", async () => {
      communitiesService.getBySlug.mockRejectedValue(
        new ForbiddenException('Members only'),
      );

      await expect(service.list(PARENT.slug, ACTOR_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(communities.find).not.toHaveBeenCalled();
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { CommunitiesService } from './communities.service';
import {
  liveInvitedUserIds,
  livePendingInvitesForInvitee,
  retireDeadPendingInvites,
  whereInviteIsLive,
} from './community-invite-liveness';
import { CommunityInviteSkipReason } from './community-invites-response';
import { CommunityInvitesService } from './community-invites.service';
import { CommunityBan } from './entities/community-ban.entity';
import {
  CommunityInvite,
  CommunityInviteStatus,
} from './entities/community-invite.entity';
import { CommunityJoinRequest } from './entities/community-join-request.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { Community } from './entities/community.entity';

// The liveness predicate is SQL; these specs drive the service's use of it.
// The predicate's own clauses are covered by `community-invite-liveness.spec.ts`.
jest.mock('./community-invite-liveness');
const mockedLiveInvitedUserIds = jest.mocked(liveInvitedUserIds);
const mockedLivePendingInvitesForInvitee = jest.mocked(
  livePendingInvitesForInvitee,
);
const mockedRetireDeadPendingInvites = jest.mocked(retireDeadPendingInvites);
const mockedWhereInviteIsLive = jest.mocked(whereInviteIsLive);

const INVITER_ID = 'inviter';
const PARENT_ID = 'parent-1';
const SPACE = {
  id: 'space-1',
  slug: 'parents-circle',
  name: 'Parents circle',
  parentId: PARENT_ID,
  archivedAt: null,
};

// The profile slugs named in the invite, and whose account each one is.
const PROFILE_ROWS = [
  { slug: 'in-parent', userId: 'user-in-parent' },
  { slug: 'outsider', userId: 'user-outsider' },
  { slug: 'banned-in-parent', userId: 'user-banned-in-parent' },
];

type WhereClause = { communityId?: unknown; userId?: unknown };

const CHAIN_METHODS = [
  'innerJoin',
  'where',
  'orderBy',
  'insert',
  'into',
  'values',
  'orIgnore',
  'returning',
] as const;

type ChainMethod = (typeof CHAIN_METHODS)[number];

/** Every chain method is a present `jest.Mock`, plus the named terminals. */
type ChainStub<Terminal extends string> = Record<
  ChainMethod | Terminal,
  jest.Mock
>;

function chainStub<Terminal extends string>(
  terminal: Record<Terminal, jest.Mock>,
): ChainStub<Terminal> {
  const chain = { ...terminal } as ChainStub<Terminal>;
  for (const method of CHAIN_METHODS) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  return chain;
}

describe('CommunityInvitesService.invite on a space', () => {
  let service: CommunityInvitesService;
  let members: { findOne: jest.Mock; find: jest.Mock };
  let bans: { find: jest.Mock };
  let insertChain: ChainStub<'execute'>;
  let notifications: { createForRecipients: jest.Mock };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockedLiveInvitedUserIds.mockResolvedValue(new Set<string>());
    mockedRetireDeadPendingInvites.mockResolvedValue(undefined);
    members = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn((options: { where: WhereClause }) => {
        const { communityId } = options.where;
        // The staff check reads the space row and the parent row in one
        // `In([...])` lookup: the inviter moderates the parent.
        if (typeof communityId !== 'string') {
          return Promise.resolve([
            {
              communityId: PARENT_ID,
              userId: INVITER_ID,
              role: RosterRole.Mod,
            },
          ]);
        }
        if (communityId === PARENT_ID) {
          return Promise.resolve([
            { userId: 'user-in-parent' },
            { userId: 'user-banned-in-parent' },
          ]);
        }
        return Promise.resolve([]);
      }),
    };
    bans = {
      find: jest.fn((options: { where: WhereClause[] }) =>
        Promise.resolve(
          options.where[0]?.communityId === PARENT_ID
            ? [{ userId: 'user-banned-in-parent' }]
            : [],
        ),
      ),
    };
    insertChain = chainStub({
      execute: jest.fn().mockResolvedValue({
        raw: [{ id: 'invite-1', invited_user_id: 'user-in-parent' }],
      }),
    });
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityInvitesService,
        {
          provide: getRepositoryToken(Community),
          useValue: { findOne: jest.fn().mockResolvedValue(SPACE) },
        },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        {
          provide: getRepositoryToken(CommunityJoinRequest),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: getRepositoryToken(CommunityBan), useValue: bans },
        {
          provide: getRepositoryToken(CommunityInvite),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
            createQueryBuilder: jest.fn(() => insertChain),
          },
        },
        {
          provide: getRepositoryToken(Profile),
          useValue: {
            createQueryBuilder: jest.fn(() =>
              chainStub({ getMany: jest.fn().mockResolvedValue(PROFILE_ROWS) }),
            ),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: NotificationsService, useValue: notifications },
        { provide: ContentModerationService, useValue: {} },
        { provide: CommunitiesService, useValue: {} },
        {
          provide: BlockFilterService,
          useValue: {
            blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
          },
        },
      ],
    }).compile();
    service = module.get(CommunityInvitesService);
  });

  it('invites parent members only and passes over outsiders and parent bans', async () => {
    const result = await service.invite(SPACE.slug, INVITER_ID, {
      memberSlugs: ['in-parent', 'outsider', 'banned-in-parent'],
    });

    expect(result.invited).toEqual(['in-parent']);
    expect(result.skipped).toEqual([
      {
        slug: 'outsider',
        reason: CommunityInviteSkipReason.NotParentMember,
      },
      { slug: 'banned-in-parent', reason: CommunityInviteSkipReason.Banned },
    ]);
  });

  it('writes no invitation row and sends no bell to anyone outside the parent', async () => {
    await service.invite(SPACE.slug, INVITER_ID, {
      memberSlugs: ['in-parent', 'outsider', 'banned-in-parent'],
    });

    expect(insertChain.values).toHaveBeenCalledWith([
      expect.objectContaining({ invitedUserId: 'user-in-parent' }),
    ]);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['user-in-parent'],
      NotificationType.CommunityInviteReceived,
      expect.objectContaining({ communitySlug: SPACE.slug }),
      INVITER_ID,
    );
  });
});

const TOP_LEVEL_COMMUNITY = {
  id: 'community-1',
  slug: 'book-club',
  name: 'Book club',
  parentId: null,
  archivedAt: null,
};

// Named members for the top-level suite, and whose account each one is.
const TOP_LEVEL_PROFILE_ROWS = [
  { slug: 'blocker', userId: 'user-blocker' },
  { slug: 'friend', userId: 'user-friend' },
  { slug: 'blocked-by-inviter', userId: 'user-blocked-by-inviter' },
  { slug: 'returning', userId: 'user-returning' },
  { slug: 'holder', userId: 'user-holder' },
];

/** `MemberLookup.userIdsForSlugs`'s query, answering only the slugs it was
 *  asked for, so each test resolves exactly the members it names. */
function profileSlugLookup(): ChainStub<'getMany'> {
  let requestedSlugs: string[] = [];
  const lookup = chainStub({
    getMany: jest.fn(() =>
      Promise.resolve(
        TOP_LEVEL_PROFILE_ROWS.filter((row) =>
          requestedSlugs.includes(row.slug),
        ),
      ),
    ),
  });
  lookup.where = jest.fn((_clause: string, params: { slugs: string[] }) => {
    requestedSlugs = params.slugs;
    return lookup;
  });
  return lookup;
}

// Full profile rows for `MemberLookup.byUserIds`, which renders a `MemberRef`.
const LISTED_PROFILES = [
  {
    userId: INVITER_ID,
    slug: 'inviter-slug',
    firstName: 'Ines',
    lastName: 'Moderator',
    pronouns: null,
    avatarUrl: null,
    photoVisible: false,
  },
  {
    userId: 'user-pending',
    slug: 'pending-person',
    firstName: 'Pat',
    lastName: 'Pending',
    pronouns: null,
    avatarUrl: null,
    photoVisible: false,
  },
  // Renderable, so only the block clause can keep this invitee off the list.
  {
    userId: 'user-blocked-by-inviter',
    slug: 'blocked-by-inviter',
    firstName: 'Bo',
    lastName: 'Blocked',
    pronouns: null,
    avatarUrl: null,
    photoVisible: false,
  },
];

function inviteRow(id: string, invitedUserId: string): CommunityInvite {
  return {
    id,
    communityId: TOP_LEVEL_COMMUNITY.id,
    invitedUserId,
    invitedByUserId: INVITER_ID,
    status: CommunityInviteStatus.Pending,
    respondedAt: null,
    expiresAt: new Date('2026-10-20T00:00:00Z'),
    revokedByUserId: null,
    createdAt: new Date('2026-09-20T00:00:00Z'),
  };
}

describe('CommunityInvitesService liveness, expiry and blocks', () => {
  let service: CommunityInvitesService;
  let invites: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let inviteChain: ChainStub<'execute' | 'getMany'>;
  let blockFilter: { blockedUserIds: jest.Mock };
  let notifications: { createForRecipients: jest.Mock };
  let communities: { findOne: jest.Mock; find: jest.Mock };
  let contentModeration: { statesFor: jest.Mock };
  let communitiesService: { cardsByCommunityId: jest.Mock };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockedLiveInvitedUserIds.mockResolvedValue(new Set<string>());
    mockedRetireDeadPendingInvites.mockResolvedValue(undefined);
    mockedWhereInviteIsLive.mockImplementation((queryBuilder) => queryBuilder);

    inviteChain = chainStub({
      execute: jest.fn().mockResolvedValue({ raw: [] }),
      getMany: jest.fn().mockResolvedValue([]),
    });
    invites = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => inviteChain),
    };
    blockFilter = {
      blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue(undefined),
    };
    communities = {
      findOne: jest.fn().mockResolvedValue(TOP_LEVEL_COMMUNITY),
      find: jest.fn().mockResolvedValue([TOP_LEVEL_COMMUNITY]),
    };
    contentModeration = { statesFor: jest.fn().mockResolvedValue(new Map()) };
    communitiesService = {
      cardsByCommunityId: jest
        .fn()
        .mockResolvedValue(
          new Map([
            [TOP_LEVEL_COMMUNITY.id, { slug: TOP_LEVEL_COMMUNITY.slug }],
          ]),
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityInvitesService,
        { provide: getRepositoryToken(Community), useValue: communities },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: {
            // The inviter moderates this top-level community; nobody named
            // is on the roster yet.
            findOne: jest.fn().mockResolvedValue({
              communityId: TOP_LEVEL_COMMUNITY.id,
              userId: INVITER_ID,
              role: RosterRole.Mod,
            }),
            find: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: getRepositoryToken(CommunityJoinRequest),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(CommunityBan),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: getRepositoryToken(CommunityInvite), useValue: invites },
        {
          provide: getRepositoryToken(Profile),
          useValue: {
            createQueryBuilder: jest.fn(() => profileSlugLookup()),
            find: jest.fn().mockResolvedValue(LISTED_PROFILES),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: NotificationsService, useValue: notifications },
        { provide: ContentModerationService, useValue: contentModeration },
        { provide: CommunitiesService, useValue: communitiesService },
        { provide: BlockFilterService, useValue: blockFilter },
      ],
    }).compile();
    service = module.get(CommunityInvitesService);
  });

  it('invite skips a member who blocked the inviter and reports them as unknown_member', async () => {
    blockFilter.blockedUserIds.mockResolvedValue(new Set(['user-blocker']));

    const result = await service.invite(TOP_LEVEL_COMMUNITY.slug, INVITER_ID, {
      memberSlugs: ['blocker'],
    });

    expect(blockFilter.blockedUserIds).toHaveBeenCalledWith(INVITER_ID, [
      'user-blocker',
    ]);
    expect(result.invited).toEqual([]);
    expect(result.skipped).toEqual([
      { slug: 'blocker', reason: CommunityInviteSkipReason.UnknownMember },
    ]);
    expect(inviteChain.insert).not.toHaveBeenCalled();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('invite skips a member the inviter blocked and sends them no bell', async () => {
    blockFilter.blockedUserIds.mockResolvedValue(
      new Set(['user-blocked-by-inviter']),
    );
    inviteChain.execute.mockResolvedValue({
      raw: [{ id: 'invite-friend', invited_user_id: 'user-friend' }],
    });

    const result = await service.invite(TOP_LEVEL_COMMUNITY.slug, INVITER_ID, {
      memberSlugs: ['friend', 'blocked-by-inviter'],
    });

    expect(result.invited).toEqual(['friend']);
    expect(result.skipped).toEqual([
      {
        slug: 'blocked-by-inviter',
        reason: CommunityInviteSkipReason.UnknownMember,
      },
    ]);
    expect(inviteChain.values).toHaveBeenCalledWith([
      expect.objectContaining({ invitedUserId: 'user-friend' }),
    ]);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['user-friend'],
      NotificationType.CommunityInviteReceived,
      expect.objectContaining({ communitySlug: TOP_LEVEL_COMMUNITY.slug }),
      INVITER_ID,
    );
  });

  it('invite retires a dead pending row before writing a fresh invitation', async () => {
    // The member still carries a pending row, but it is dead (expired, say),
    // so the liveness read reports nobody as invited.
    mockedLiveInvitedUserIds.mockResolvedValue(new Set<string>());
    inviteChain.execute.mockResolvedValue({
      raw: [{ id: 'invite-fresh', invited_user_id: 'user-returning' }],
    });

    const result = await service.invite(TOP_LEVEL_COMMUNITY.slug, INVITER_ID, {
      memberSlugs: ['returning'],
    });

    expect(mockedLiveInvitedUserIds).toHaveBeenCalledWith(
      invites,
      TOP_LEVEL_COMMUNITY.id,
      ['user-returning'],
    );
    expect(mockedRetireDeadPendingInvites).toHaveBeenCalledWith(
      invites,
      TOP_LEVEL_COMMUNITY.id,
      ['user-returning'],
    );
    // A missing call reads as a failing order: retire as last, insert as first.
    const [retireCallOrder = Number.POSITIVE_INFINITY] =
      mockedRetireDeadPendingInvites.mock.invocationCallOrder;
    const [insertCallOrder = 0] = inviteChain.insert.mock.invocationCallOrder;
    expect(retireCallOrder).toBeLessThan(insertCallOrder);
    expect(inviteChain.values).toHaveBeenCalledWith([
      expect.objectContaining({ invitedUserId: 'user-returning' }),
    ]);
    expect(result.invited).toEqual(['returning']);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['user-returning'],
      NotificationType.CommunityInviteReceived,
      expect.objectContaining({ communitySlug: TOP_LEVEL_COMMUNITY.slug }),
      INVITER_ID,
    );
  });

  it('invite reports already_invited for a member holding a live invitation', async () => {
    mockedLiveInvitedUserIds.mockResolvedValue(new Set(['user-holder']));

    const result = await service.invite(TOP_LEVEL_COMMUNITY.slug, INVITER_ID, {
      memberSlugs: ['holder'],
    });

    expect(result.skipped).toEqual([
      { slug: 'holder', reason: CommunityInviteSkipReason.AlreadyInvited },
    ]);
    expect(mockedRetireDeadPendingInvites).not.toHaveBeenCalled();
    expect(inviteChain.insert).not.toHaveBeenCalled();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('listMine reads through livePendingInvitesForInvitee so expired and blocked invitations never reach the shelf', async () => {
    // A bare status read would also return this expired row; the shelf must
    // show only what the liveness helper hands back.
    invites.find.mockResolvedValue([
      inviteRow('invite-expired', 'user-pending'),
    ]);
    mockedLivePendingInvitesForInvitee.mockResolvedValue([
      inviteRow('invite-live', 'user-pending'),
    ]);

    const result = await service.listMine('user-pending');

    expect(mockedLivePendingInvitesForInvitee).toHaveBeenCalledWith(
      invites,
      'user-pending',
    );
    expect(invites.find).not.toHaveBeenCalled();
    expect(result.items.map((item) => item.id)).toEqual(['invite-live']);
  });

  it('listPending lists live invitations through the liveness predicate with blocks honoured', async () => {
    inviteChain.getMany.mockResolvedValue([
      inviteRow('invite-pending', 'user-pending'),
    ]);

    const result = await service.listPending(
      TOP_LEVEL_COMMUNITY.slug,
      INVITER_ID,
    );

    expect(inviteChain.where).toHaveBeenCalledWith(
      '"ci"."community_id" = :communityId',
      { communityId: TOP_LEVEL_COMMUNITY.id },
    );
    expect(mockedWhereInviteIsLive).toHaveBeenCalledWith(inviteChain, 'ci');
    expect(inviteChain.orderBy).toHaveBeenCalledWith(
      '"ci"."created_at"',
      'DESC',
    );
    expect(invites.find).not.toHaveBeenCalled();
    expect(
      result.items.map((item) => [
        item.id,
        item.member.slug,
        item.invitedBy?.slug,
      ]),
    ).toEqual([['invite-pending', 'pending-person', 'inviter-slug']]);
  });

  it('listPending hides an invitation whose inviter and invitee block each other', async () => {
    // Stands in for the SQL predicate: once the block clause applies, the
    // invitation across a block between inviter and invitee drops out, so a
    // co-moderator never sees a row that a re-invite would treat as absent.
    let isHonouringBlocks = false;
    mockedWhereInviteIsLive.mockImplementation(
      (queryBuilder, _alias, options) => {
        isHonouringBlocks = options?.shouldHonourBlocks ?? true;
        return queryBuilder;
      },
    );
    inviteChain.getMany.mockImplementation(() =>
      Promise.resolve(
        isHonouringBlocks
          ? [inviteRow('invite-pending', 'user-pending')]
          : [
              inviteRow('invite-pending', 'user-pending'),
              inviteRow('invite-across-block', 'user-blocked-by-inviter'),
            ],
      ),
    );

    const result = await service.listPending(
      TOP_LEVEL_COMMUNITY.slug,
      INVITER_ID,
    );

    expect(isHonouringBlocks).toBe(true);
    expect(result.items.map((item) => item.id)).toEqual(['invite-pending']);
  });
});

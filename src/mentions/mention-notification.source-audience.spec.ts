import { FindOperator } from 'typeorm';
import {
  MentionNotificationService,
  threadPassesPublishGate,
} from './mention-notification.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { RosterRole } from '../communities/entities/community-member.entity';
import { AccessTier } from '../communities/entities/community.entity';
import { MemberLookup } from '../common/member-ref';
import { isThreadPublished } from '../forum/forum-threads.service';
import { UserRole } from '../users/entities/user.entity';

// U10: every recipient bucket of a community-post or forum mention is held to
// the people who can read the place it was written. The fakes below honour the
// `where` filters the service sends (equality or `In(...)`), so each test
// states who holds which seat and the service's own queries decide who passes.

const PAST = new Date('2020-01-01T00:00:00.000Z');
const FUTURE = new Date('2999-01-01T00:00:00.000Z');

interface CommunityFixture {
  id: string;
  slug: string;
  ownerId: string | null;
  accessTier: AccessTier;
  parentId: string | null;
  archivedAt: Date | null;
}

interface RosterFixture {
  communityId: string;
  userId: string;
  role: RosterRole;
}

interface ThreadFixture {
  id: string;
  slug: string;
  authorId: string | null;
  communityId: string | null;
  crossPosted: boolean;
  publishedAt: Date;
  reviewState: string | null;
}

function community(
  fields: Partial<CommunityFixture> & Pick<CommunityFixture, 'id' | 'slug'>,
): CommunityFixture {
  return {
    ownerId: null,
    accessTier: AccessTier.Public,
    parentId: null,
    archivedAt: null,
    ...fields,
  };
}

function thread(
  fields: Partial<ThreadFixture> & Pick<ThreadFixture, 'slug'>,
): ThreadFixture {
  return {
    id: `id-${fields.slug}`,
    authorId: 'user-thread-author',
    communityId: null,
    crossPosted: false,
    publishedAt: PAST,
    reviewState: null,
    ...fields,
  };
}

const COMMUNITIES: CommunityFixture[] = [
  community({
    id: 'community-pride',
    slug: 'pride',
    ownerId: 'user-pride-owner',
  }),
  community({
    id: 'community-private',
    slug: 'private-circle',
    ownerId: 'user-private-owner',
    accessTier: AccessTier.Private,
  }),
  community({ id: 'community-public', slug: 'public-square' }),
  community({
    id: 'community-archived',
    slug: 'archived-square',
    archivedAt: PAST,
  }),
  community({ id: 'community-parent', slug: 'parent-circle' }),
  community({
    id: 'community-hidden-space',
    slug: 'hidden-space',
    accessTier: AccessTier.Private,
    parentId: 'community-parent',
  }),
  community({
    id: 'community-public-space',
    slug: 'public-space',
    parentId: 'community-parent',
  }),
  // A live public community the takedown cases hide or remove by slug.
  community({
    id: 'community-closed',
    slug: 'closed-circle',
    ownerId: 'user-closed-owner',
  }),
];

const ROSTER: RosterFixture[] = [
  {
    communityId: 'community-pride',
    userId: 'user-pride-owner',
    role: RosterRole.Owner,
  },
  {
    communityId: 'community-pride',
    userId: 'user-pride-mod',
    role: RosterRole.Mod,
  },
  {
    communityId: 'community-private',
    userId: 'user-insider',
    role: RosterRole.Member,
  },
  {
    communityId: 'community-archived',
    userId: 'user-insider',
    role: RosterRole.Member,
  },
  // Space seats: a seat under a parent seat, an orphaned space seat, parent
  // staff with no space seat, and a plain parent member.
  {
    communityId: 'community-hidden-space',
    userId: 'user-seated',
    role: RosterRole.Member,
  },
  {
    communityId: 'community-parent',
    userId: 'user-seated',
    role: RosterRole.Member,
  },
  {
    communityId: 'community-hidden-space',
    userId: 'user-orphan',
    role: RosterRole.Member,
  },
  {
    communityId: 'community-parent',
    userId: 'user-parent-mod',
    role: RosterRole.Mod,
  },
  {
    communityId: 'community-parent',
    userId: 'user-parent-member',
    role: RosterRole.Member,
  },
  {
    communityId: 'community-public-space',
    userId: 'user-seated',
    role: RosterRole.Member,
  },
  // Every roster role in the community the takedown cases close.
  {
    communityId: 'community-closed',
    userId: 'user-closed-owner',
    role: RosterRole.Owner,
  },
  {
    communityId: 'community-closed',
    userId: 'user-closed-co-owner',
    role: RosterRole.CoOwner,
  },
  {
    communityId: 'community-closed',
    userId: 'user-closed-mod',
    role: RosterRole.Mod,
  },
  {
    communityId: 'community-closed',
    userId: 'user-closed-member',
    role: RosterRole.Member,
  },
];

const SOURCE_THREADS: ThreadFixture[] = [
  thread({ slug: 'global-thread' }),
  thread({ slug: 'gated-thread', communityId: 'community-private' }),
  thread({
    slug: 'cross-posted-thread',
    communityId: 'community-private',
    crossPosted: true,
  }),
  thread({ slug: 'scheduled-thread', publishedAt: FUTURE }),
  thread({ slug: 'pending-thread', reviewState: 'pending' }),
  thread({ slug: 'rejected-thread', reviewState: 'rejected' }),
  thread({ slug: 'approved-thread', reviewState: 'approved' }),
  thread({ slug: 'public-thread', communityId: 'community-public' }),
  thread({
    slug: 'public-space-thread',
    communityId: 'community-public-space',
  }),
  thread({ slug: 'archived-thread', communityId: 'community-archived' }),
  thread({ slug: 'orphan-community-thread', communityId: 'community-gone' }),
  thread({ slug: 'erased-author-thread', authorId: null }),
  thread({
    slug: 'scheduled-gated-thread',
    communityId: 'community-private',
    publishedAt: FUTURE,
  }),
];

const MEMBER_USER_IDS: Record<string, string> = {
  insider: 'user-insider',
  outsider: 'user-outsider',
  seated: 'user-seated',
  orphan: 'user-orphan',
  'parent-mod': 'user-parent-mod',
  'parent-member': 'user-parent-member',
  'thread-author': 'user-thread-author',
  bystander: 'user-bystander',
  'platform-mod': 'user-platform-mod',
  'platform-admin': 'user-platform-admin',
  'closed-owner': 'user-closed-owner',
  'closed-co-owner': 'user-closed-co-owner',
  'closed-mod': 'user-closed-mod',
  'closed-member': 'user-closed-member',
};

// Account roles the platform staff read sees. Everyone absent here is a
// plain member, which the role filter drops the same way.
const USER_ROLES: Array<{ id: string; role: UserRole }> = [
  { id: 'user-platform-mod', role: UserRole.Moderator },
  { id: 'user-platform-admin', role: UserRole.Admin },
  { id: 'user-outsider', role: UserRole.Member },
];

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition === undefined) return true;
  if (condition instanceof FindOperator) {
    return (condition.value as unknown[]).includes(value);
  }
  return value === condition;
}

function matchesWhere(row: object, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) =>
    matchesCondition((row as Record<string, unknown>)[key], condition),
  );
}

type WhereArgument = { where: Record<string, unknown> };

type TakedownState = 'hidden' | 'removed';

// `blocks` lists [blocker, blocked] pairs; the fake answers either way, as
// `BlockFilterService.blockedUserIds` does. `takenDown` maps a community slug
// to the moderation state a moderator left on it; every other slug is visible.
function build(
  options: {
    blocks?: Array<[string, string]>;
    takenDown?: Record<string, TakedownState>;
  } = {},
) {
  const blocks = options.blocks ?? [];
  const takenDown = options.takenDown ?? {};
  const communities = {
    find: jest.fn(({ where }: WhereArgument) =>
      Promise.resolve(COMMUNITIES.filter((row) => matchesWhere(row, where))),
    ),
    findOne: jest.fn(({ where }: WhereArgument) =>
      Promise.resolve(
        COMMUNITIES.find((row) => matchesWhere(row, where)) ?? null,
      ),
    ),
  };
  const members = {
    find: jest.fn(({ where }: WhereArgument) =>
      Promise.resolve(ROSTER.filter((row) => matchesWhere(row, where))),
    ),
  };
  const listings = {
    find: jest
      .fn()
      .mockResolvedValue([{ slug: 'corner-cafe', ownerId: 'user-lister' }]),
  };
  const events = {
    find: jest
      .fn()
      .mockResolvedValue([{ slug: 'pride-picnic', hostId: 'user-host' }]),
  };
  const threads = {
    // The `t/slug` lookup for a thread mention.
    find: jest
      .fn()
      .mockResolvedValue([{ slug: 'housing-tips', authorId: 'user-writer' }]),
    // The forum source lookup. `deletedAt: IsNull()` is a FindOperator the
    // fixtures carry no column for, so only the slug is matched here.
    findOne: jest.fn(({ where }: WhereArgument) =>
      Promise.resolve(
        SOURCE_THREADS.find((row) => row.slug === where.slug) ?? null,
      ),
    ),
  };
  const conversationParticipants = {
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(),
  };
  const notifications = {
    createForRecipients: jest.fn<
      Promise<string[]>,
      Parameters<NotificationsService['createForRecipients']>
    >((userIds) => Promise.resolve(userIds)),
    create: jest.fn().mockResolvedValue(undefined),
  };
  const users = {
    find: jest.fn(({ where }: WhereArgument) =>
      Promise.resolve(USER_ROLES.filter((row) => matchesWhere(row, where))),
    ),
  };
  const blockFilter = {
    blockedUserIds: jest.fn((actorId: string, candidateIds: string[]) =>
      Promise.resolve(
        new Set(
          candidateIds.filter((candidateId) =>
            blocks.some(
              ([blockerId, blockedId]) =>
                (blockerId === actorId && blockedId === candidateId) ||
                (blockerId === candidateId && blockedId === actorId),
            ),
          ),
        ),
      ),
    ),
  };
  const contentModeration = {
    stateFor: jest.fn((subjectType: string, subjectId: string) => {
      const takedownState =
        subjectType === 'community' ? takenDown[subjectId] : undefined;
      return Promise.resolve({
        hidden: takedownState === 'hidden',
        removed: takedownState === 'removed',
      });
    }),
  };
  jest
    .spyOn(MemberLookup.prototype, 'userIdsForSlugs')
    .mockImplementation((slugs: string[]) =>
      Promise.resolve(
        new Map(
          slugs
            .filter((slug) => MEMBER_USER_IDS[slug] !== undefined)
            .map((slug) => [slug, MEMBER_USER_IDS[slug]!] as const),
        ),
      ),
    );

  const service = new MentionNotificationService(
    {} as never,
    communities as never,
    members as never,
    listings as never,
    events as never,
    threads as never,
    conversationParticipants as never,
    users as never,
    notifications as never,
    blockFilter as never,
    contentModeration as never,
    {} as never,
  );

  const notifiedRecipients = () =>
    new Set(
      notifications.createForRecipients.mock.calls.flatMap((call) => call[0]),
    );

  return {
    service,
    communities,
    members,
    threads,
    users,
    blockFilter,
    contentModeration,
    notifications,
    notifiedRecipients,
  };
}

const ENTITY_MENTIONS = 'c/pride e/pride-picnic b/corner-cafe t/housing-tips';
const ENTITY_STEWARDS = [
  'user-pride-owner',
  'user-pride-mod',
  'user-host',
  'user-lister',
  'user-writer',
];

function communityPayload(communitySlug: string) {
  return {
    actorId: 'author-1',
    source: 'community',
    communitySlug,
    postId: 'post-1',
    excerpt: 'something said on the board',
  };
}

function forumPayload(threadSlug: string) {
  return {
    actorId: 'author-1',
    source: 'forum',
    threadSlug,
    postId: 'post-1',
    excerpt: 'something said in the thread',
  };
}

describe('MentionNotificationService.notify, community post audience (U10)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('notifies no entity steward outside a private community, and still notifies the member inside it', async () => {
    const { service, notifiedRecipients } = build();

    await service.notify(
      `@insider @outsider ${ENTITY_MENTIONS}`,
      'author-1',
      communityPayload('private-circle'),
    );

    expect(notifiedRecipients()).toEqual(new Set(['user-insider']));
  });

  it('notifies an entity steward who holds a seat in the private community', async () => {
    const { service, members, notifiedRecipients } = build();
    const rosterWithHost = [
      ...ROSTER,
      {
        communityId: 'community-private',
        userId: 'user-host',
        role: RosterRole.Member,
      },
    ];
    members.find.mockImplementation(({ where }: WhereArgument) =>
      Promise.resolve(rosterWithHost.filter((row) => matchesWhere(row, where))),
    );

    await service.notify(
      ENTITY_MENTIONS,
      'author-1',
      communityPayload('private-circle'),
    );

    expect(notifiedRecipients()).toEqual(new Set(['user-host']));
  });

  it('lets every entity steward through on a live public community board', async () => {
    const { service, notifiedRecipients } = build();

    await service.notify(
      `@outsider ${ENTITY_MENTIONS}`,
      'author-1',
      communityPayload('public-square'),
    );

    expect(notifiedRecipients()).toEqual(
      new Set(['user-outsider', ...ENTITY_STEWARDS]),
    );
  });

  it('holds an archived public community to its roster', async () => {
    const { service, notifiedRecipients } = build();

    await service.notify(
      `@insider @outsider ${ENTITY_MENTIONS}`,
      'author-1',
      communityPayload('archived-square'),
    );

    expect(notifiedRecipients()).toEqual(new Set(['user-insider']));
  });

  it('inside a gated space, admits a seat under a parent seat and parent staff, and drops an orphaned space seat and a plain parent member', async () => {
    const { service, notifiedRecipients } = build();

    await service.notify(
      '@seated @orphan @parent-mod @parent-member',
      'author-1',
      communityPayload('hidden-space'),
    );

    expect(notifiedRecipients()).toEqual(
      new Set(['user-seated', 'user-parent-mod']),
    );
  });

  it('reads the roster once for the whole fan-out, parent rows included for a space', async () => {
    const { service, members } = build();

    await service.notify(
      '@seated @orphan',
      'author-1',
      communityPayload('hidden-space'),
    );

    const rosterReads = members.find.mock.calls.filter(
      ([argument]) => argument.where.userId !== undefined,
    );
    expect(rosterReads).toHaveLength(1);
    const communityCondition = rosterReads[0]![0].where
      .communityId as FindOperator<string[]>;
    expect(communityCondition.value).toEqual([
      'community-hidden-space',
      'community-parent',
    ]);
  });
});

describe('MentionNotificationService.notify, forum thread audience (U10)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lets every recipient through on a published global thread, reading no community', async () => {
    const { service, communities, notifiedRecipients } = build();

    await service.notify(
      `@outsider ${ENTITY_MENTIONS}`,
      'author-1',
      forumPayload('global-thread'),
    );

    expect(notifiedRecipients()).toEqual(
      new Set(['user-outsider', ...ENTITY_STEWARDS]),
    );
    expect(communities.findOne).not.toHaveBeenCalled();
  });

  it('holds a thread in a gated community to its roster, entity stewards included', async () => {
    const { service, notifiedRecipients } = build();

    await service.notify(
      `@insider @outsider ${ENTITY_MENTIONS}`,
      'author-1',
      forumPayload('gated-thread'),
    );

    expect(notifiedRecipients()).toEqual(new Set(['user-insider']));
  });

  it('lets every recipient through on a cross-posted thread from a gated community', async () => {
    const { service, communities, members, notifiedRecipients } = build();

    await service.notify(
      '@insider @outsider',
      'author-1',
      forumPayload('cross-posted-thread'),
    );

    expect(notifiedRecipients()).toEqual(
      new Set(['user-insider', 'user-outsider']),
    );
    expect(communities.findOne).not.toHaveBeenCalled();
    expect(members.find).not.toHaveBeenCalled();
  });

  it('lets every recipient through on a thread in a top-level public community', async () => {
    const { service, notifiedRecipients } = build();

    await service.notify(
      '@insider @outsider',
      'author-1',
      forumPayload('public-thread'),
    );

    expect(notifiedRecipients()).toEqual(
      new Set(['user-insider', 'user-outsider']),
    );
  });

  it('holds a thread in a public space to the space effective roster', async () => {
    const { service, notifiedRecipients } = build();

    await service.notify(
      '@seated @outsider @parent-member',
      'author-1',
      forumPayload('public-space-thread'),
    );

    expect(notifiedRecipients()).toEqual(new Set(['user-seated']));
  });

  it('holds a thread in an archived community to its roster', async () => {
    const { service, notifiedRecipients } = build();

    await service.notify(
      '@insider @outsider',
      'author-1',
      forumPayload('archived-thread'),
    );

    expect(notifiedRecipients()).toEqual(new Set(['user-insider']));
  });

  it.each(['scheduled-thread', 'pending-thread', 'rejected-thread'])(
    'a reply in %s notifies the thread author and platform staff alone',
    async (threadSlug) => {
      const { service, notifiedRecipients } = build();

      await service.notify(
        `@thread-author @bystander @platform-mod @platform-admin ${ENTITY_MENTIONS}`,
        'author-1',
        forumPayload(threadSlug),
      );

      expect(notifiedRecipients()).toEqual(
        new Set([
          'user-thread-author',
          'user-platform-mod',
          'user-platform-admin',
        ]),
      );
    },
  );

  it('reads no platform staff roles when no gate drops anybody', async () => {
    const { service, users, notifiedRecipients } = build();

    await service.notify(
      '@bystander @platform-mod',
      'author-1',
      forumPayload('global-thread'),
    );

    expect(notifiedRecipients()).toEqual(
      new Set(['user-bystander', 'user-platform-mod']),
    );
    expect(users.find).not.toHaveBeenCalled();
  });

  it('notifies a platform moderator off the roster of a gated community thread', async () => {
    const { service, users, notifiedRecipients } = build();

    await service.notify(
      '@insider @outsider @platform-mod',
      'author-1',
      forumPayload('gated-thread'),
    );

    expect(notifiedRecipients()).toEqual(
      new Set(['user-insider', 'user-platform-mod']),
    );
    expect(users.find).toHaveBeenCalledTimes(1);
  });

  it('reads platform staff roles once when both gates drop somebody', async () => {
    const { service, users, notifiedRecipients } = build();

    await service.notify(
      '@thread-author @insider @outsider @platform-mod',
      'author-1',
      forumPayload('scheduled-gated-thread'),
    );

    // The publish gate drops the roster member, the community gate drops
    // the author (no seat), and staff pass both on one role read.
    expect(notifiedRecipients()).toEqual(new Set(['user-platform-mod']));
    expect(users.find).toHaveBeenCalledTimes(1);
  });

  it('drops a member and an entity steward blocked either way with the thread author', async () => {
    const { service, notifiedRecipients } = build({
      blocks: [
        ['user-outsider', 'user-thread-author'],
        ['user-thread-author', 'user-host'],
      ],
    });

    await service.notify(
      `@outsider @bystander ${ENTITY_MENTIONS}`,
      'author-1',
      forumPayload('global-thread'),
    );

    expect(notifiedRecipients()).toEqual(
      new Set([
        'user-bystander',
        'user-pride-owner',
        'user-pride-mod',
        'user-lister',
        'user-writer',
      ]),
    );
  });

  it('drops a platform moderator blocked with the thread author, with no staff bypass', async () => {
    const { service, notifiedRecipients } = build({
      blocks: [['user-thread-author', 'user-platform-mod']],
    });

    await service.notify(
      '@thread-author @platform-mod @platform-admin',
      'author-1',
      forumPayload('scheduled-thread'),
    );

    expect(notifiedRecipients()).toEqual(
      new Set(['user-thread-author', 'user-platform-admin']),
    );
  });

  it('reads no blocks for a thread whose author erased their account', async () => {
    const { service, blockFilter, notifiedRecipients } = build();

    await service.notify(
      '@insider @outsider',
      'author-1',
      forumPayload('erased-author-thread'),
    );

    expect(notifiedRecipients()).toEqual(
      new Set(['user-insider', 'user-outsider']),
    );
    expect(blockFilter.blockedUserIds).not.toHaveBeenCalled();
  });

  it('lets every recipient through on an approved thread', async () => {
    const { service, notifiedRecipients } = build();

    await service.notify(
      '@thread-author @bystander',
      'author-1',
      forumPayload('approved-thread'),
    );

    expect(notifiedRecipients()).toEqual(
      new Set(['user-thread-author', 'user-bystander']),
    );
  });

  it('fails closed on a thread that cannot be loaded', async () => {
    const { service, notifiedRecipients } = build();

    await service.notify(
      '@insider @outsider',
      'author-1',
      forumPayload('vanished-thread'),
    );

    expect(notifiedRecipients()).toEqual(new Set());
  });

  it('fails closed on a community thread whose community cannot be loaded', async () => {
    const { service, notifiedRecipients } = build();

    await service.notify(
      '@insider @outsider',
      'author-1',
      forumPayload('orphan-community-thread'),
    );

    expect(notifiedRecipients()).toEqual(new Set());
  });

  it('fails closed on a forum payload carrying no threadSlug', async () => {
    const { service, threads, notifiedRecipients } = build();

    await service.notify('@insider', 'author-1', {
      actorId: 'author-1',
      source: 'forum',
      excerpt: 'something said somewhere',
    });

    expect(notifiedRecipients()).toEqual(new Set());
    expect(threads.findOne).not.toHaveBeenCalled();
  });
});

describe('MentionNotificationService reply notifications, source audience', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['notifyParentReply', 'notifyThreadReply'] as const)(
    '%s skips a recipient who left the gated community',
    async (method) => {
      const { service, notifications } = build();

      await service[method](
        'user-outsider',
        'author-1',
        forumPayload('gated-thread'),
      );

      expect(notifications.create).not.toHaveBeenCalled();
    },
  );

  it.each(['notifyParentReply', 'notifyThreadReply'] as const)(
    '%s still notifies a recipient on the gated community roster',
    async (method) => {
      const { service, notifications } = build();
      const payload = forumPayload('gated-thread');

      await service[method]('user-insider', 'author-1', payload);

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        'user-insider',
        expect.anything(),
        payload,
        'author-1',
      );
    },
  );

  it('notifyParentReply skips a parent author blocked with the thread author', async () => {
    const { service, notifications } = build({
      blocks: [['user-bystander', 'user-thread-author']],
    });

    await service.notifyParentReply(
      'user-bystander',
      'author-1',
      forumPayload('global-thread'),
    );

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('notifyThreadReply skips the audience read when the caller already checked it', async () => {
    const { service, threads, notifications } = build();

    await service.notifyThreadReply(
      'user-insider',
      'author-1',
      forumPayload('gated-thread'),
      { isAudienceChecked: true },
    );

    expect(threads.findOne).not.toHaveBeenCalled();
    expect(notifications.create).toHaveBeenCalledTimes(1);
  });

  it('notifyThreadReply fails closed, and quietly, when the audience read throws', async () => {
    const { service, threads, notifications } = build();
    threads.findOne.mockRejectedValue(new Error('connection lost'));

    await expect(
      service.notifyThreadReply(
        'user-insider',
        'author-1',
        forumPayload('global-thread'),
      ),
    ).resolves.toBeUndefined();

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('notifyPostReply skips a post author who left a private community', async () => {
    const { service, notifications } = build();

    await service.notifyPostReply(
      'user-outsider',
      'author-1',
      communityPayload('private-circle'),
    );

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('notifyPostReply still notifies a post author on the private community roster', async () => {
    const { service, notifications } = build();

    await service.notifyPostReply(
      'user-insider',
      'author-1',
      communityPayload('private-circle'),
    );

    expect(notifications.create).toHaveBeenCalledTimes(1);
  });

  it('forumThreadAudience narrows many candidates with one thread read and answers nobody on a failed read', async () => {
    const { service, threads } = build();

    const audience = await service.forumThreadAudience('gated-thread', [
      'user-insider',
      'user-outsider',
      'user-platform-mod',
    ]);

    expect(audience).toEqual(new Set(['user-insider', 'user-platform-mod']));
    expect(threads.findOne).toHaveBeenCalledTimes(1);

    threads.findOne.mockRejectedValue(new Error('connection lost'));
    await expect(
      service.forumThreadAudience('gated-thread', ['user-insider']),
    ).resolves.toEqual(new Set());
  });
});

describe('MentionNotificationService, community a moderator took down', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['hidden', 'removed'] as const)(
    'a %s community notifies its owner, co-owner and mod, and drops a member, an outsider and every entity steward',
    async (takedownState) => {
      const { service, contentModeration, notifiedRecipients } = build({
        takenDown: { 'closed-circle': takedownState },
      });

      await service.notify(
        `@closed-owner @closed-co-owner @closed-mod @closed-member @outsider ${ENTITY_MENTIONS}`,
        'author-1',
        communityPayload('closed-circle'),
      );

      expect(notifiedRecipients()).toEqual(
        new Set([
          'user-closed-owner',
          'user-closed-co-owner',
          'user-closed-mod',
        ]),
      );
      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'community',
        'closed-circle',
      );
    },
  );

  it('a taken-down space notifies parent staff and drops a space member seated under a parent seat', async () => {
    const { service, notifiedRecipients } = build({
      takenDown: { 'hidden-space': 'removed' },
    });

    await service.notify(
      '@seated @orphan @parent-mod @parent-member',
      'author-1',
      communityPayload('hidden-space'),
    );

    expect(notifiedRecipients()).toEqual(new Set(['user-parent-mod']));
  });

  it.each(['hidden', 'removed'] as const)(
    'notifyPostReply skips a plain member post author in a %s community',
    async (takedownState) => {
      const { service, notifications } = build({
        takenDown: { 'closed-circle': takedownState },
      });

      await service.notifyPostReply(
        'user-closed-member',
        'user-closed-mod',
        communityPayload('closed-circle'),
      );

      expect(notifications.create).not.toHaveBeenCalled();
    },
  );

  it('notifyPostReply still notifies a mod post author in a removed community', async () => {
    const { service, notifications } = build({
      takenDown: { 'closed-circle': 'removed' },
    });
    const payload = communityPayload('closed-circle');

    await service.notifyPostReply(
      'user-closed-mod',
      'user-closed-owner',
      payload,
    );

    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith(
      'user-closed-mod',
      expect.anything(),
      payload,
      'user-closed-owner',
    );
  });

  it('notifies nobody on a taken-down slug whose community row is gone', async () => {
    const { service, notifiedRecipients } = build({
      takenDown: { 'vanished-circle': 'removed' },
    });

    await service.notify(
      '@outsider @closed-mod',
      'author-1',
      communityPayload('vanished-circle'),
    );

    expect(notifiedRecipients()).toEqual(new Set());
  });

  it('keeps failing open on an unresolvable slug nobody took down', async () => {
    const { service, notifiedRecipients } = build();

    await service.notify(
      '@outsider',
      'author-1',
      communityPayload('vanished-circle'),
    );

    expect(notifiedRecipients()).toEqual(new Set(['user-outsider']));
  });

  it('fails closed, and quietly, when the takedown read throws', async () => {
    const { service, contentModeration, notifications, notifiedRecipients } =
      build();
    contentModeration.stateFor.mockRejectedValue(new Error('connection lost'));

    await expect(
      service.notify(
        '@closed-mod @outsider',
        'author-1',
        communityPayload('public-square'),
      ),
    ).resolves.toEqual(new Set());
    await expect(
      service.notifyPostReply(
        'user-closed-mod',
        'author-1',
        communityPayload('public-square'),
      ),
    ).resolves.toBeUndefined();

    expect(notifiedRecipients()).toEqual(new Set());
    expect(notifications.create).not.toHaveBeenCalled();
  });
});

describe('MentionNotificationService.notify, source classification (U10)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['an unknown source', { source: 'event-comment', excerpt: 'said there' }],
    ['a payload carrying no source', { excerpt: 'said somewhere' }],
  ])('fails closed on %s', async (_label, payload) => {
    const { service, notifiedRecipients } = build();

    await service.notify(`@insider ${ENTITY_MENTIONS}`, 'author-1', {
      actorId: 'author-1',
      ...payload,
    });

    expect(notifiedRecipients()).toEqual(new Set());
  });

  it('lets every recipient through on a global post, a community payload with no communitySlug', async () => {
    const { service, communities, contentModeration, notifiedRecipients } =
      build();

    await service.notify(`@outsider ${ENTITY_MENTIONS}`, 'author-1', {
      actorId: 'author-1',
      source: 'community',
      postId: 'post-1',
      excerpt: 'said on the global feed',
    });

    expect(notifiedRecipients()).toEqual(
      new Set(['user-outsider', ...ENTITY_STEWARDS]),
    );
    expect(communities.findOne).not.toHaveBeenCalled();
    expect(contentModeration.stateFor).not.toHaveBeenCalled();
  });
});

describe('threadPassesPublishGate mirrors the forum isThreadPublished', () => {
  // `reviewState` undefined covers a row read without that column; `held` is
  // a made-up state, so this table goes red the day the forum makes a new
  // review state visible and the mirror has to learn it too.
  const cases: Array<{ publishedAt: Date; reviewState?: string | null }> = [
    { publishedAt: PAST, reviewState: null },
    { publishedAt: PAST, reviewState: undefined },
    { publishedAt: PAST, reviewState: 'approved' },
    { publishedAt: PAST, reviewState: 'pending' },
    { publishedAt: PAST, reviewState: 'rejected' },
    { publishedAt: PAST, reviewState: 'held' },
    { publishedAt: FUTURE, reviewState: null },
    { publishedAt: FUTURE, reviewState: undefined },
    { publishedAt: FUTURE, reviewState: 'approved' },
    { publishedAt: FUTURE, reviewState: 'pending' },
    { publishedAt: FUTURE, reviewState: 'held' },
  ];

  it.each(cases)(
    'agrees for publishedAt $publishedAt and reviewState $reviewState',
    (threadState) => {
      const loadedThread = threadState as {
        publishedAt: Date;
        reviewState: string | null;
      };
      expect(threadPassesPublishGate(loadedThread)).toBe(
        isThreadPublished(loadedThread),
      );
    },
  );
});

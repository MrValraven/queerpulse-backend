import { FindOperator, Repository } from 'typeorm';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Event } from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Listing } from '../listings/entities/listing.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Profile } from '../users/entities/profile.entity';
import { MentionNameResolveService } from './mention-name-resolve.service';

/**
 * U10: a `t/slug` resolves to its title only for a viewer who could open the
 * thread, by the same gates the mention fan-out uses: the forum's publish gate
 * (scheduled, pending and rejected threads name themselves to their author
 * alone) and the thread's community audience (global and cross-posted threads
 * are open to everyone; a gated community or a space names its threads to its
 * effective roster). The fakes honour the `where` filters the service sends.
 */

const PAST = new Date('2020-01-01T00:00:00.000Z');
const FUTURE = new Date('2999-01-01T00:00:00.000Z');

const VIEWER_ID = 'viewer-1';
const AUTHOR_ID = 'author-1';

function community(
  fields: Partial<Community> & Pick<Community, 'id' | 'slug'>,
): Community {
  return {
    name: `Name of ${fields.slug}`,
    accessTier: AccessTier.Public,
    parentId: null,
    archivedAt: null,
    ...fields,
  } as Community;
}

function thread(
  fields: Partial<ForumThread> & Pick<ForumThread, 'slug'>,
): ForumThread {
  return {
    id: `id-${fields.slug}`,
    title: `Title of ${fields.slug}`,
    authorId: AUTHOR_ID,
    communityId: null,
    crossPosted: false,
    publishedAt: PAST,
    reviewState: null,
    deletedAt: null,
    ...fields,
  } as ForumThread;
}

const COMMUNITIES: Community[] = [
  community({
    id: 'community-private',
    slug: 'private-circle',
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
];

const THREADS: ForumThread[] = [
  thread({ slug: 'global-thread' }),
  thread({ slug: 'scheduled-thread', publishedAt: FUTURE }),
  thread({ slug: 'pending-thread', reviewState: 'pending' }),
  thread({ slug: 'rejected-thread', reviewState: 'rejected' }),
  thread({ slug: 'approved-thread', reviewState: 'approved' }),
  thread({ slug: 'gated-thread', communityId: 'community-private' }),
  thread({
    slug: 'cross-posted-thread',
    communityId: 'community-private',
    crossPosted: true,
  }),
  thread({ slug: 'public-thread', communityId: 'community-public' }),
  thread({ slug: 'archived-thread', communityId: 'community-archived' }),
  thread({
    slug: 'hidden-space-thread',
    communityId: 'community-hidden-space',
  }),
  thread({
    slug: 'public-space-thread',
    communityId: 'community-public-space',
  }),
  thread({ slug: 'orphan-community-thread', communityId: 'community-gone' }),
];

interface RosterRow {
  communityId: string;
  userId: string;
  role: RosterRole;
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition === undefined) return true;
  if (condition instanceof FindOperator) {
    return (condition.value as unknown[]).includes(value);
  }
  return value === condition;
}

// Matches only the columns a fixture row carries, so the service's
// `deletedAt: IsNull()` filter on threads is ignored here (every fixture is a
// live thread).
function matchesWhere(row: object, where: Record<string, unknown>): boolean {
  return Object.entries(where)
    .filter(([key]) => key !== 'deletedAt')
    .every(([key, condition]) =>
      matchesCondition((row as Record<string, unknown>)[key], condition),
    );
}

type WhereArgument = { where: Record<string, unknown> };

function buildService(roster: RosterRow[] = []) {
  const communities = {
    find: jest.fn(({ where }: WhereArgument) =>
      Promise.resolve(COMMUNITIES.filter((row) => matchesWhere(row, where))),
    ),
  };
  const communityMembers = {
    find: jest.fn(({ where }: WhereArgument) =>
      Promise.resolve(roster.filter((row) => matchesWhere(row, where))),
    ),
  };
  const threads = {
    find: jest.fn(({ where }: WhereArgument) =>
      Promise.resolve(THREADS.filter((row) => matchesWhere(row, where))),
    ),
  };
  const empty = { find: jest.fn().mockResolvedValue([]) };
  const service = new MentionNameResolveService(
    {} as unknown as Repository<Profile>,
    communities as unknown as Repository<Community>,
    communityMembers as unknown as Repository<CommunityMember>,
    empty as unknown as Repository<Listing>,
    empty as unknown as Repository<Event>,
    threads as unknown as Repository<ForumThread>,
    { findOne: jest.fn() } as unknown as Repository<Conversation>,
    empty as unknown as Repository<ConversationParticipant>,
  );
  return { service, communities, communityMembers };
}

async function resolvedThreadSlugs(
  service: MentionNameResolveService,
  viewerId: string,
  threadSlugs: string[],
): Promise<string[]> {
  const resolved = await service.resolve(
    viewerId,
    threadSlugs.map((slug) => `thread:${slug}`),
  );
  return resolved
    .filter((entry) => entry.kind === 'thread')
    .map((entry) => entry.slug)
    .sort();
}

describe('MentionNameResolveService, thread readability (U10)', () => {
  it('names a published global thread and an approved one, reading no community', async () => {
    const { service, communities } = buildService();

    const slugs = await resolvedThreadSlugs(service, VIEWER_ID, [
      'global-thread',
      'approved-thread',
    ]);

    expect(slugs).toEqual(['approved-thread', 'global-thread']);
    expect(communities.find).not.toHaveBeenCalled();
  });

  it('leaves scheduled, pending and rejected threads unnamed for a reader', async () => {
    const { service } = buildService();

    const slugs = await resolvedThreadSlugs(service, VIEWER_ID, [
      'scheduled-thread',
      'pending-thread',
      'rejected-thread',
    ]);

    expect(slugs).toEqual([]);
  });

  it('names scheduled, pending and rejected threads for their own author', async () => {
    const { service } = buildService();

    const slugs = await resolvedThreadSlugs(service, AUTHOR_ID, [
      'scheduled-thread',
      'pending-thread',
      'rejected-thread',
    ]);

    expect(slugs).toEqual([
      'pending-thread',
      'rejected-thread',
      'scheduled-thread',
    ]);
  });

  it('names a cross-posted thread from a private community for a non-member', async () => {
    const { service } = buildService();

    const slugs = await resolvedThreadSlugs(service, VIEWER_ID, [
      'cross-posted-thread',
    ]);

    expect(slugs).toEqual(['cross-posted-thread']);
  });

  it('names a gated community thread for its member and leaves it unnamed for anyone else', async () => {
    const memberRoster: RosterRow[] = [
      {
        communityId: 'community-private',
        userId: VIEWER_ID,
        role: RosterRole.Member,
      },
    ];

    const forOutsider = await resolvedThreadSlugs(
      buildService().service,
      VIEWER_ID,
      ['gated-thread'],
    );
    const forMember = await resolvedThreadSlugs(
      buildService(memberRoster).service,
      VIEWER_ID,
      ['gated-thread'],
    );

    expect(forOutsider).toEqual([]);
    expect(forMember).toEqual(['gated-thread']);
  });

  it('names a top-level public community thread for anyone', async () => {
    const { service } = buildService();

    const slugs = await resolvedThreadSlugs(service, VIEWER_ID, [
      'public-thread',
    ]);

    expect(slugs).toEqual(['public-thread']);
  });

  it('holds an archived community thread and a public space thread to their rosters', async () => {
    const { service } = buildService();

    const slugs = await resolvedThreadSlugs(service, VIEWER_ID, [
      'archived-thread',
      'public-space-thread',
    ]);

    expect(slugs).toEqual([]);
  });

  it('names a gated space thread for parent staff with no space seat', async () => {
    const { service, communityMembers } = buildService([
      {
        communityId: 'community-parent',
        userId: VIEWER_ID,
        role: RosterRole.Mod,
      },
    ]);

    const slugs = await resolvedThreadSlugs(service, VIEWER_ID, [
      'hidden-space-thread',
    ]);

    expect(slugs).toEqual(['hidden-space-thread']);
    // One roster read, the parent included alongside the space.
    expect(communityMembers.find).toHaveBeenCalledTimes(1);
    const [argument] = communityMembers.find.mock.calls[0]!;
    const communityCondition = argument.where.communityId as FindOperator<
      string[]
    >;
    expect(communityCondition.value).toEqual(
      expect.arrayContaining(['community-hidden-space', 'community-parent']),
    );
  });

  it('leaves a gated space thread unnamed for an orphaned space seat and for a plain parent member', async () => {
    const forOrphan = await resolvedThreadSlugs(
      buildService([
        {
          communityId: 'community-hidden-space',
          userId: VIEWER_ID,
          role: RosterRole.Member,
        },
      ]).service,
      VIEWER_ID,
      ['hidden-space-thread'],
    );
    const forParentMember = await resolvedThreadSlugs(
      buildService([
        {
          communityId: 'community-parent',
          userId: VIEWER_ID,
          role: RosterRole.Member,
        },
      ]).service,
      VIEWER_ID,
      ['hidden-space-thread'],
    );

    expect(forOrphan).toEqual([]);
    expect(forParentMember).toEqual([]);
  });

  it('leaves a thread unnamed when its community cannot be loaded', async () => {
    const { service } = buildService();

    const slugs = await resolvedThreadSlugs(service, VIEWER_ID, [
      'orphan-community-thread',
    ]);

    expect(slugs).toEqual([]);
  });

  it('keeps the community name gate: a private community names itself to its roster alone', async () => {
    const refs = ['community:private-circle', 'community:public-square'];
    const forOutsider = await buildService().service.resolve(VIEWER_ID, refs);
    const forMember = await buildService([
      {
        communityId: 'community-private',
        userId: VIEWER_ID,
        role: RosterRole.Member,
      },
    ]).service.resolve(VIEWER_ID, refs);

    expect(forOutsider.map((entry) => entry.slug)).toEqual(['public-square']);
    expect(forMember.map((entry) => entry.slug).sort()).toEqual([
      'private-circle',
      'public-square',
    ]);
  });
});

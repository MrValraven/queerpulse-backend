import { CommunityPost, PostKind } from './entities/community-post.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { RosterRole } from './entities/community-member.entity';
import {
  AccessTier,
  Community,
  CommunityType,
} from './entities/community.entity';
import {
  CommunityStats,
  ReactionAggregate,
  toCommunityDetail,
  toCommunityPost,
  toCommunityReply,
} from './community-response';

const EMPTY_STATS: CommunityStats = {
  memberCount: 0,
  activeThisWeek: 0,
  postsThisWeek: 0,
};

function makeCommunity(overrides: Partial<Community> = {}): Community {
  return {
    id: 'community-1',
    slug: 'community',
    name: 'Community',
    purpose: 'purpose',
    type: CommunityType.Social,
    whoFor: 'who this is for',
    tagline: 'tagline',
    accessTier: AccessTier.Public,
    rosterVisible: true,
    requiresSecondVouch: false,
    autoFreezeOnReports: false,
    isFeatured: false,
    features: [],
    rules: [],
    tags: [],
    coverImageUrl: null,
    ownerId: 'owner-1',
    ref: 'QP-C-0001',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    archivedAt: null,
    frozenAt: null,
    frozenReason: null,
    needsOwnerReviewAt: null,
    rulesVersion: 1,
    welcomeMessage: null,
    nowReading: null,
    avatarImageUrl: null,
    city: null,
    area: null,
    isOnline: false,
    languages: [],
    activeThisWeek: 0,
    activityCountedAt: null,
    isPubliclyListed: false,
    frozenNote: null,
    frozenByUserId: null,
    parentId: null,
    allowsSubcommunities: false,
    archivedWithParent: false,
    ...overrides,
  };
}

// No reactions / no replies — the shared "empty" input every permission-flag
// test below passes, since none of them exercise reaction/reply content.
const EMPTY_REACTIONS: ReactionAggregate = {
  counts: new Map(),
  mine: new Set(),
};

function makePost(overrides: Partial<CommunityPost> = {}): CommunityPost {
  return {
    id: 'post-1',
    communityId: 'community-1',
    authorId: 'author-1',
    body: 'hello',
    image: null,
    kind: PostKind.Post,
    pinned: false,
    createdAt: new Date('2026-07-23T10:00:00Z'),
    editedAt: null,
    deletedAt: null,
    deletedById: null,
    ...overrides,
  };
}

function makeReply(
  overrides: Partial<CommunityPostReply> = {},
): CommunityPostReply {
  return {
    id: 'reply-1',
    postId: 'post-1',
    authorId: 'author-1',
    text: 'hi there',
    createdAt: new Date('2026-07-23T10:05:00Z'),
    editedAt: null,
    deletedAt: null,
    deletedById: null,
    ...overrides,
  };
}

describe('toCommunityPost / toCommunityReply permission flags', () => {
  it('author can edit + delete their own live post', () => {
    const dto = toCommunityPost(
      makePost(),
      null,
      EMPTY_REACTIONS,
      [],
      0,
      'author-1',
      RosterRole.Member,
    );
    expect(dto.canEdit).toBe(true);
    expect(dto.canDelete).toBe(true);
    expect(dto.canRestore).toBe(false);
  });

  it('owner/mod can delete but NOT edit another member post', () => {
    const dto = toCommunityPost(
      makePost(),
      null,
      EMPTY_REACTIONS,
      [],
      0,
      'mod-1',
      RosterRole.Mod,
    );
    expect(dto.canEdit).toBe(false);
    expect(dto.canDelete).toBe(true);
  });

  it('a plain member (non-author) can do nothing', () => {
    const dto = toCommunityPost(
      makePost(),
      null,
      EMPTY_REACTIONS,
      [],
      0,
      'other-1',
      RosterRole.Member,
    );
    expect(dto.canEdit).toBe(false);
    expect(dto.canDelete).toBe(false);
    expect(dto.canRestore).toBe(false);
    expect(dto.canViewHistory).toBe(false);
  });

  it('a non-member viewer can do nothing', () => {
    const dto = toCommunityPost(
      makePost(),
      null,
      EMPTY_REACTIONS,
      [],
      0,
      'nobody',
      null,
    );
    expect(dto.canDelete).toBe(false);
  });

  it('an ex-member author (left the community) can no longer edit or delete', () => {
    const dto = toCommunityPost(
      makePost(),
      null,
      EMPTY_REACTIONS,
      [],
      0,
      'author-1',
      null,
    );
    expect(dto.canEdit).toBe(false);
    expect(dto.canDelete).toBe(false);
  });

  it('tombstoned post hides body/author and offers restore to owner/mod', () => {
    const dto = toCommunityPost(
      makePost({ deletedAt: new Date() }),
      {
        slug: 'a',
        firstName: 'A',
        lastName: 'B',
        pronouns: null,
        avatarUrl: null,
      },
      EMPTY_REACTIONS,
      [],
      0,
      'mod-1',
      RosterRole.Owner,
    );
    expect(dto.deleted).toBe(true);
    expect(dto.body).toBe('');
    expect(dto.author?.slug).toBe('');
    expect(dto.canRestore).toBe(true);
    expect(dto.canDelete).toBe(false);
  });

  it('canViewHistory only once edited, for author/owner/mod', () => {
    const edited = makePost({ editedAt: new Date() });
    expect(
      toCommunityPost(
        edited,
        null,
        EMPTY_REACTIONS,
        [],
        0,
        'author-1',
        RosterRole.Member,
      ).canViewHistory,
    ).toBe(true);
    expect(
      toCommunityPost(
        edited,
        null,
        EMPTY_REACTIONS,
        [],
        0,
        'mod-1',
        RosterRole.Mod,
      ).canViewHistory,
    ).toBe(true);
    expect(
      toCommunityPost(
        edited,
        null,
        EMPTY_REACTIONS,
        [],
        0,
        'other-1',
        RosterRole.Member,
      ).canViewHistory,
    ).toBe(false);
    expect(
      toCommunityPost(
        makePost(),
        null,
        EMPTY_REACTIONS,
        [],
        0,
        'author-1',
        RosterRole.Member,
      ).canViewHistory,
    ).toBe(false);
  });

  it('reply flags mirror post flags (edit author-only; delete author-or-owner/mod)', () => {
    const authored = toCommunityReply(
      makeReply(),
      null,
      'author-1',
      RosterRole.Member,
    );
    expect(authored.canEdit).toBe(true);
    expect(authored.canDelete).toBe(true);
    const byMod = toCommunityReply(makeReply(), null, 'mod-1', RosterRole.Mod);
    expect(byMod.canEdit).toBe(false);
    expect(byMod.canDelete).toBe(true);
  });
});

describe('toCommunityDetail subcommunity fields', () => {
  it('a space carries its parent summary and inherits the parent rules', () => {
    const parent = makeCommunity({
      id: 'parent-1',
      slug: 'parent',
      name: 'Parent',
      avatarImageUrl: 'parent-avatar-key',
      rules: ['Be kind', 'No spam'],
      rulesVersion: 3,
      allowsSubcommunities: true,
    });
    const space = makeCommunity({
      id: 'space-1',
      slug: 'space',
      name: 'Space',
      parentId: parent.id,
      allowsSubcommunities: false,
    });

    const dto = toCommunityDetail(
      space,
      EMPTY_STATS,
      RosterRole.Member,
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      {
        parent,
        isParentMember: true,
        subcommunityCount: 0,
        isRosterMember: false,
      },
    );

    expect(dto.parent).toEqual({
      slug: 'parent',
      name: 'Parent',
      avatarImageUrl: expect.any(String),
      isMember: true,
    });
    expect(dto.inheritedRules).toEqual({
      rules: ['Be kind', 'No spam'],
      rulesVersion: 3,
    });
    expect(dto.subcommunityCount).toBe(0);
  });

  it('isMember reads false for a space viewer with no roster row of their own in the parent', () => {
    const parent = makeCommunity({ id: 'parent-1', slug: 'parent' });
    const space = makeCommunity({
      id: 'space-1',
      slug: 'space',
      parentId: parent.id,
    });

    const dto = toCommunityDetail(
      space,
      EMPTY_STATS,
      RosterRole.Mod, // inherited from a parent mod, no own row in the parent
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      {
        parent,
        isParentMember: false,
        subcommunityCount: 0,
        isRosterMember: false,
      },
    );

    expect(dto.parent?.isMember).toBe(false);
  });

  it('a top-level community has no parent/inheritedRules and carries its own subcommunity count', () => {
    const topLevel = makeCommunity({
      id: 'top-1',
      slug: 'top',
      allowsSubcommunities: true,
    });

    const dto = toCommunityDetail(
      topLevel,
      EMPTY_STATS,
      RosterRole.Owner,
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      {
        parent: null,
        isParentMember: false,
        subcommunityCount: 4,
        isRosterMember: true,
      },
    );

    expect(dto.isRosterMember).toBe(true);
    expect(dto.parent).toBeNull();
    expect(dto.inheritedRules).toBeNull();
    expect(dto.allowsSubcommunities).toBe(true);
    expect(dto.subcommunityCount).toBe(4);
  });
});

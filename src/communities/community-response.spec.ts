import { CommunityPost, PostKind } from './entities/community-post.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import {
  CommunityMember,
  CommunityNotificationLevel,
  RosterRole,
} from './entities/community-member.entity';
import {
  AccessTier,
  Community,
  CommunityType,
} from './entities/community.entity';
import type { MemberRef } from '../common/member-ref';
import type { CommunityNameMarks } from '../community-badges/community-badge-response';
import {
  CommunityStats,
  ReactionAggregate,
  toCommunityDetail,
  toCommunityPost,
  toCommunityReply,
  toRosterEntry,
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
    givingIntro: null,
    setupChecklistDismissedAt: null,
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
      avatarImageUrl: 'https://cdn.example.com/parent-avatar.png',
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
      avatarImageUrl: 'https://cdn.example.com/parent-avatar.png',
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

describe('toCommunityDetail giving method count', () => {
  it('carries the giving method count, defaulting to 0', () => {
    const community = makeCommunity();

    const defaultedDto = toCommunityDetail(
      community,
      EMPTY_STATS,
      RosterRole.Member,
      null,
      null,
    );
    const countedDto = toCommunityDetail(
      community,
      EMPTY_STATS,
      RosterRole.Member,
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      undefined,
      3,
    );

    expect(defaultedDto.givingMethodCount).toBe(0);
    expect(countedDto.givingMethodCount).toBe(3);
  });
});

describe('toCommunityDetail setup checklist', () => {
  it('emits the setup checklist for a mod of a top-level community', () => {
    const dto = toCommunityDetail(
      makeCommunity({
        setupChecklistDismissedAt: new Date('2026-11-20T10:00:00.000Z'),
      }),
      EMPTY_STATS,
      RosterRole.Mod,
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      undefined,
      0,
      { staffCount: 2, postCount: 0 },
    );

    expect(dto.setupChecklist).toEqual({
      isDismissed: true,
      staffCount: 2,
      postCount: 0,
    });
  });

  it('leaves the key off when no counts were loaded', () => {
    const dto = toCommunityDetail(
      makeCommunity(),
      EMPTY_STATS,
      RosterRole.Owner,
      null,
      null,
    );

    expect(Object.keys(dto)).not.toContain('setupChecklist');
  });

  it('leaves the key off for a member and for a space even when counts are passed', () => {
    const counts = { staffCount: 1, postCount: 3 };
    const memberDto = toCommunityDetail(
      makeCommunity(),
      EMPTY_STATS,
      RosterRole.Member,
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      undefined,
      0,
      counts,
    );
    const spaceDto = toCommunityDetail(
      makeCommunity({ parentId: 'parent-1' }),
      EMPTY_STATS,
      RosterRole.Owner,
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      undefined,
      0,
      counts,
    );

    expect(Object.keys(memberDto)).not.toContain('setupChecklist');
    expect(Object.keys(spaceDto)).not.toContain('setupChecklist');
  });
});

describe('name marks', () => {
  const memberRef: MemberRef = {
    slug: 'author',
    firstName: 'Author',
    lastName: 'Member',
    pronouns: null,
    avatarUrl: null,
  };

  const marks: CommunityNameMarks = {
    flair: {
      name: 'Regular',
      starterKey: 'regular',
      iconKey: 'calendar',
      tint: 'jade',
    },
    hasRecentGift: true,
  };

  function makeMember(
    overrides: Partial<CommunityMember> = {},
  ): CommunityMember {
    return {
      id: 'membership-1',
      communityId: 'community-1',
      userId: 'author-1',
      role: RosterRole.Member,
      joinedAt: new Date('2026-01-02T00:00:00.000Z'),
      notificationLevel: CommunityNotificationLevel.Announcements,
      rulesAcceptedAt: null,
      rulesVersionAccepted: null,
      welcomeSeenAt: null,
      wornBadgeId: null,
      eventsAttendedCount: 0,
      ...overrides,
    };
  }

  it('places flair and the gift mark right after role on a roster entry', () => {
    const entry = toRosterEntry(makeMember(), memberRef, marks);
    expect(Object.keys(entry)).toEqual([
      'member',
      'role',
      'flair',
      'hasRecentGift',
      'joinedAt',
    ]);
    expect(entry.flair).toEqual(marks.flair);
    expect(entry.hasRecentGift).toBe(true);
  });

  it('gives a roster entry no marks when none are passed', () => {
    const entry = toRosterEntry(makeMember(), memberRef);
    expect(entry.flair).toBeNull();
    expect(entry.hasRecentGift).toBe(false);
  });

  it('defaults to no marks when none are passed', () => {
    const dto = toCommunityPost(
      makePost(),
      memberRef,
      EMPTY_REACTIONS,
      [],
      0,
      'viewer-1',
      RosterRole.Member,
    );
    expect(dto.authorFlair).toBeNull();
    expect(dto.authorHasRecentGift).toBe(false);
    const reply = toCommunityReply(
      makeReply(),
      memberRef,
      'viewer-1',
      RosterRole.Member,
    );
    expect(reply.authorFlair).toBeNull();
    expect(reply.authorHasRecentGift).toBe(false);
  });

  it('carries the author marks right after author on a live post and reply', () => {
    const post = toCommunityPost(
      makePost(),
      memberRef,
      EMPTY_REACTIONS,
      [],
      0,
      'viewer-1',
      RosterRole.Member,
      undefined,
      marks,
    );
    expect(Object.keys(post).slice(0, 4)).toEqual([
      'id',
      'author',
      'authorFlair',
      'authorHasRecentGift',
    ]);
    expect(post.authorFlair).toEqual(marks.flair);
    expect(post.authorHasRecentGift).toBe(true);
    const reply = toCommunityReply(
      makeReply(),
      memberRef,
      'viewer-1',
      RosterRole.Member,
      undefined,
      marks,
    );
    expect(Object.keys(reply).slice(0, 4)).toEqual([
      'id',
      'author',
      'authorFlair',
      'authorHasRecentGift',
    ]);
    expect(reply.authorFlair).toEqual(marks.flair);
    expect(reply.authorHasRecentGift).toBe(true);
  });

  it('blanks authorFlair and authorHasRecentGift for a tombstoned post', () => {
    const dto = toCommunityPost(
      makePost({ deletedAt: new Date() }),
      memberRef,
      EMPTY_REACTIONS,
      [],
      0,
      'viewer-1',
      RosterRole.Member,
      undefined,
      marks,
    );
    expect(dto.authorFlair).toBeNull();
    expect(dto.authorHasRecentGift).toBe(false);
  });

  it('blanks the marks for a moderator-removed post', () => {
    const dto = toCommunityPost(
      makePost(),
      memberRef,
      EMPTY_REACTIONS,
      [],
      0,
      'viewer-1',
      RosterRole.Member,
      { hidden: false, removed: true },
      marks,
    );
    expect(dto.authorFlair).toBeNull();
    expect(dto.authorHasRecentGift).toBe(false);
  });

  it('blanks the marks for a moderator-hidden reply and a null author', () => {
    const hiddenReply = toCommunityReply(
      makeReply(),
      memberRef,
      'viewer-1',
      RosterRole.Member,
      { hidden: true, removed: false },
      marks,
    );
    expect(hiddenReply.authorFlair).toBeNull();
    expect(hiddenReply.authorHasRecentGift).toBe(false);
    const authorlessReply = toCommunityReply(
      makeReply(),
      null,
      'viewer-1',
      RosterRole.Member,
      undefined,
      marks,
    );
    expect(authorlessReply.authorFlair).toBeNull();
    expect(authorlessReply.authorHasRecentGift).toBe(false);
  });

  // A paused, suspended or deleting author renders as the anonymous
  // "[deactivated member]" stand-in, so the byline carries no marks either.
  const inactiveRef: MemberRef = {
    slug: '',
    firstName: '',
    lastName: '',
    pronouns: null,
    avatarUrl: null,
    isInactiveMember: true,
  };

  it('blanks the marks on a live post whose author is the inactive placeholder', () => {
    const dto = toCommunityPost(
      makePost(),
      inactiveRef,
      EMPTY_REACTIONS,
      [],
      0,
      'viewer-1',
      RosterRole.Member,
      undefined,
      marks,
    );
    expect(dto.author).toEqual(inactiveRef);
    expect(dto.authorFlair).toBeNull();
    expect(dto.authorHasRecentGift).toBe(false);
  });

  it('blanks the marks on a live reply whose author is the inactive placeholder', () => {
    const dto = toCommunityReply(
      makeReply(),
      inactiveRef,
      'viewer-1',
      RosterRole.Member,
      undefined,
      marks,
    );
    expect(dto.author).toEqual(inactiveRef);
    expect(dto.authorFlair).toBeNull();
    expect(dto.authorHasRecentGift).toBe(false);
  });

  it('blanks the marks for a tombstoned reply', () => {
    const dto = toCommunityReply(
      makeReply({ deletedAt: new Date() }),
      memberRef,
      'viewer-1',
      RosterRole.Member,
      undefined,
      marks,
    );
    expect(dto.authorFlair).toBeNull();
    expect(dto.authorHasRecentGift).toBe(false);
  });
});

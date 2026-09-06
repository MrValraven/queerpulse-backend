import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
import { toForumPostResponse, toForumThreadResponse } from './forum-response';

// A COMPLETE default typed as `ForumPost` itself, so TS rejects it outright
// if it ever omits a field the entity declares — spreading `Partial<ForumPost>`
// overrides directly over an incomplete literal instead would silently widen
// any field the literal omitted (e.g. `deletedById`) to `X | undefined`,
// which fails assignability against the entity's `X | null` column type.
const forumPostDefaults: ForumPost = {
  id: 'post-1',
  threadId: 'thread-1',
  parentPostId: null,
  authorId: 'author-1',
  body: 'hello',
  image: null,
  voteCount: 0,
  isOp: false,
  createdAt: new Date('2026-07-23T10:00:00Z'),
  editedAt: null,
  deletedAt: null,
  deletedById: null,
};

function makePost(overrides: Partial<ForumPost> = {}): ForumPost {
  return { ...forumPostDefaults, ...overrides };
}

// Same "complete default, typed as the entity" rule as `forumPostDefaults`
// above, for the same reason: a field the literal omits would widen to
// `X | undefined` and stop being assignable to the entity's `X | null`.
const forumThreadDefaults: ForumThread = {
  id: 'thread-1',
  slug: 'hello',
  title: 'Hello',
  authorId: 'author-1',
  category: 'general',
  communityId: null,
  isPinned: false,
  pinnedAt: null,
  isLocked: false,
  lockReason: null,
  isOfficial: false,
  acceptedPostId: null,
  tags: [],
  opVoteCount: 0,
  replyCount: 0,
  lastActivityAt: new Date('2026-07-23T10:00:00Z'),
  createdAt: new Date('2026-07-23T10:00:00Z'),
  deletedAt: null,
  deletedById: null,
};

function makeThread(overrides: Partial<ForumThread> = {}): ForumThread {
  return { ...forumThreadDefaults, ...overrides };
}

describe('toForumPostResponse permission flags', () => {
  const staff = { userId: 'mod-1', isModerator: true };
  const author = { userId: 'author-1', isModerator: false };
  const stranger = { userId: 'other-1', isModerator: false };

  it('author can edit + delete their own live post', () => {
    const dto = toForumPostResponse(makePost(), null, 0, author);
    expect(dto.canEdit).toBe(true);
    expect(dto.canDelete).toBe(true);
    expect(dto.canRestore).toBe(false);
  });

  it('staff can delete but NOT edit another member post', () => {
    const dto = toForumPostResponse(makePost(), null, 0, staff);
    expect(dto.canEdit).toBe(false);
    expect(dto.canDelete).toBe(true);
  });

  it('stranger can do nothing', () => {
    const dto = toForumPostResponse(makePost(), null, 0, stranger);
    expect(dto.canEdit).toBe(false);
    expect(dto.canDelete).toBe(false);
  });

  it('tombstoned post hides body/author and offers restore to staff', () => {
    const dto = toForumPostResponse(
      makePost({ deletedAt: new Date() }),
      {
        slug: 'a',
        firstName: 'A',
        lastName: 'B',
        pronouns: null,
        avatarUrl: null,
      },
      0,
      staff,
    );
    expect(dto.deleted).toBe(true);
    expect(dto.body).toBe('');
    expect(dto.author.displayName).toBe('');
    expect(dto.canRestore).toBe(true);
    expect(dto.canDelete).toBe(false);
  });

  it('canViewHistory only once edited, for author/staff', () => {
    const edited = makePost({ editedAt: new Date() });
    expect(toForumPostResponse(edited, null, 0, author).canViewHistory).toBe(
      true,
    );
    expect(toForumPostResponse(edited, null, 0, stranger).canViewHistory).toBe(
      false,
    );
    expect(
      toForumPostResponse(makePost(), null, 0, author).canViewHistory,
    ).toBe(false);
  });
});

describe('toForumThreadResponse official author', () => {
  const author = { userId: 'author-1', isModerator: false };
  const realAuthor = {
    slug: 'ava',
    firstName: 'Ava',
    lastName: 'Lee',
    avatarUrl: null,
  } as never;

  it('swaps the displayed author for "QueerPulse Official" when isOfficial is set', () => {
    const dto = toForumThreadResponse(
      makeThread({ isOfficial: true }),
      realAuthor,
      author,
    );
    expect(dto.author).toEqual({
      handle: 'queerpulse',
      displayName: 'QueerPulse',
      avatarUrl: null,
      official: true,
    });
  });

  it('shows the real author when isOfficial is false', () => {
    const dto = toForumThreadResponse(
      makeThread({ isOfficial: false }),
      realAuthor,
      author,
    );
    expect(dto.author).toEqual({
      handle: 'ava',
      displayName: 'Ava Lee',
      avatarUrl: null,
    });
  });
});

describe('toForumThreadResponse OP card flags', () => {
  const author = { userId: 'author-1', isModerator: false };
  const moderator = { userId: 'mod-1', isModerator: true };
  const stranger = { userId: 'other-1', isModerator: false };

  it('author of a live OP can delete, not lock; no restore/history', () => {
    const dto = toForumThreadResponse(
      makeThread(),
      null,
      author,
      makePost({ authorId: 'author-1' }),
    );
    expect(dto.canDelete).toBe(true);
    expect(dto.canRestore).toBe(false);
    expect(dto.canViewHistory).toBe(false);
    expect(dto.canLock).toBe(false);
    expect(dto.canPin).toBe(false);
  });

  it('moderator can delete + lock + pin another member OP', () => {
    const dto = toForumThreadResponse(
      makeThread(),
      null,
      moderator,
      makePost({ authorId: 'author-1' }),
    );
    expect(dto.canDelete).toBe(true);
    expect(dto.canLock).toBe(true);
    expect(dto.canPin).toBe(true);
  });

  it('stranger can do nothing', () => {
    const dto = toForumThreadResponse(
      makeThread(),
      null,
      stranger,
      makePost({ authorId: 'author-1' }),
    );
    expect(dto.canDelete).toBe(false);
    expect(dto.canRestore).toBe(false);
    expect(dto.canViewHistory).toBe(false);
    expect(dto.canLock).toBe(false);
  });

  it('tombstoned OP offers restore (not delete) to author/moderator', () => {
    const dto = toForumThreadResponse(
      makeThread(),
      null,
      moderator,
      makePost({ deletedAt: new Date() }),
    );
    expect(dto.canRestore).toBe(true);
    expect(dto.canDelete).toBe(false);
  });

  it('edited OP exposes history to author/moderator', () => {
    const dto = toForumThreadResponse(
      makeThread(),
      null,
      author,
      makePost({ authorId: 'author-1', editedAt: new Date() }),
    );
    expect(dto.canViewHistory).toBe(true);
  });

  it('a missing OP zeroes the per-post flags but a moderator can still lock', () => {
    const dto = toForumThreadResponse(makeThread(), null, moderator, null);
    expect(dto.opPostId).toBe('');
    expect(dto.canDelete).toBe(false);
    expect(dto.canRestore).toBe(false);
    expect(dto.canViewHistory).toBe(false);
    expect(dto.canLock).toBe(true);
  });
});

// PRD-160 — the thread's own tombstone, distinct from the OP post's.
describe('toForumThreadResponse isDeleted', () => {
  const moderator = { userId: 'mod-1', isModerator: true };

  it('is false for a live thread', () => {
    expect(toForumThreadResponse(makeThread(), null, moderator).isDeleted).toBe(
      false,
    );
  });

  it('is true for a withdrawn thread', () => {
    const dto = toForumThreadResponse(
      makeThread({ deletedAt: new Date(), deletedById: 'author-1' }),
      null,
      moderator,
    );
    expect(dto.isDeleted).toBe(true);
  });
});

// PRD-167 — the thread card's taste of the opening post.
describe('toForumThreadResponse excerpt', () => {
  const author = { userId: 'author-1', isModerator: false };

  it('is null when no OP was resolved', () => {
    expect(
      toForumThreadResponse(makeThread(), null, author).excerpt,
    ).toBeNull();
  });

  it('strips markup and collapses whitespace', () => {
    const dto = toForumThreadResponse(
      makeThread(),
      null,
      author,
      makePost({ body: '<p>Where do I find\n\n  an <b>affirming</b> GP?</p>' }),
    );
    expect(dto.excerpt).toBe('Where do I find an affirming GP?');
  });

  it('truncates a long body on a word boundary and marks the cut', () => {
    const body = 'lisbon '.repeat(60).trim();
    const dto = toForumThreadResponse(
      makeThread(),
      null,
      author,
      makePost({ body }),
    );
    expect(dto.excerpt).not.toBeNull();
    const excerpt = dto.excerpt ?? '';
    expect(excerpt.endsWith('…')).toBe(true);
    // The window is the text; the ellipsis is the marker sitting on top of it.
    expect(excerpt.length).toBeLessThanOrEqual(181);
    expect(excerpt).not.toMatch(/lisbo…$/);
  });

  it('is null for a body that strips down to nothing (an image-only post)', () => {
    const dto = toForumThreadResponse(
      makeThread(),
      null,
      author,
      makePost({ body: '<p>   </p>' }),
    );
    expect(dto.excerpt).toBeNull();
  });

  it('is null for a tombstoned OP', () => {
    const dto = toForumThreadResponse(
      makeThread(),
      null,
      author,
      makePost({ body: 'still here', deletedAt: new Date() }),
    );
    expect(dto.excerpt).toBeNull();
  });

  // The reason the excerpt consults moderation at all: the thread list never
  // carried any of the body before, so a takedown had nothing to leak through.
  it('is null for an OP a moderator removed', () => {
    const dto = toForumThreadResponse(
      makeThread(),
      null,
      author,
      makePost({ body: 'taken down' }),
      0,
      false,
      { hidden: true, removed: true },
    );
    expect(dto.excerpt).toBeNull();
  });

  it('is null for an OP a moderator merely hid', () => {
    const dto = toForumThreadResponse(
      makeThread(),
      null,
      author,
      makePost({ body: 'withheld' }),
      0,
      false,
      { hidden: true, removed: false },
    );
    expect(dto.excerpt).toBeNull();
  });

  it('survives an explicitly unmoderated OP', () => {
    const dto = toForumThreadResponse(
      makeThread(),
      null,
      author,
      makePost({ body: 'visible' }),
      0,
      false,
      { hidden: false, removed: false },
    );
    expect(dto.excerpt).toBe('visible');
  });
});

// --- C5 / ENG-130: the OP is a flag, never a position ------------------------
// The thread page took the first post of page one AS the OP. When the server
// dropped the OP from that page (a muted thread author, or a moderator-hidden
// OP read by a non-moderator), the first REPLY slid into the OP card and was
// rendered as the question, wearing that replier's name and permissions, while
// vanishing from the reply list underneath.
describe('toForumPostResponse isOp', () => {
  const viewer = { userId: 'other-1', isModerator: false };

  it('is true only for the thread opening post', () => {
    expect(
      toForumPostResponse(makePost({ isOp: true }), null, 0, viewer).isOp,
    ).toBe(true);
    expect(toForumPostResponse(makePost(), null, 0, viewer).isOp).toBe(false);
  });

  it('stays true on a tombstoned opening post', () => {
    // A withdrawn OP is still the OP: the page must keep rendering it in the OP
    // slot as a tombstone rather than promoting a reply into that slot.
    const dto = toForumPostResponse(
      makePost({ isOp: true, deletedAt: new Date() }),
      null,
      0,
      viewer,
    );
    expect(dto.isOp).toBe(true);
    expect(dto.body).toBe('');
  });

  it('stays true on an opening post a moderator removed', () => {
    const dto = toForumPostResponse(makePost({ isOp: true }), null, 0, viewer, {
      hidden: false,
      removed: true,
    });
    expect(dto.isOp).toBe(true);
  });
});

// --- C7 / PRD-170: the unread badge ------------------------------------------
describe('toForumThreadResponse unreadReplyCount', () => {
  const viewer = { userId: 'viewer-1', isModerator: false };

  it('is null when the caller resolved no watermark', () => {
    // Anonymous viewer, never-opened thread, or a write echo: all the same
    // statement, "no unread information", never "nothing is new".
    expect(
      toForumThreadResponse(makeThread(), null, viewer).unreadReplyCount,
    ).toBeNull();
  });

  it('carries the resolved count through, zero included', () => {
    const opened = toForumThreadResponse(
      makeThread(),
      null,
      viewer,
      null,
      0,
      false,
      undefined,
      0,
    );
    expect(opened.unreadReplyCount).toBe(0);

    const behind = toForumThreadResponse(
      makeThread(),
      null,
      viewer,
      null,
      0,
      false,
      undefined,
      7,
    );
    expect(behind.unreadReplyCount).toBe(7);
  });
});

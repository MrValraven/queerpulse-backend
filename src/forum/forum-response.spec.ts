import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
import { toForumPostResponse, toForumThreadResponse } from './forum-response';

function makePost(overrides: Partial<ForumPost> = {}): ForumPost {
  return {
    id: 'post-1',
    threadId: 'thread-1',
    parentPostId: null,
    authorId: 'author-1',
    body: 'hello',
    voteCount: 0,
    isOp: false,
    createdAt: new Date('2026-07-23T10:00:00Z'),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeThread(overrides: Partial<ForumThread> = {}): ForumThread {
  return {
    id: 'thread-1',
    slug: 'hello',
    title: 'Hello',
    authorId: 'author-1',
    category: 'general',
    communityId: null,
    isPinned: false,
    isLocked: false,
    tags: [],
    opVoteCount: 0,
    replyCount: 0,
    lastActivityAt: new Date('2026-07-23T10:00:00Z'),
    createdAt: new Date('2026-07-23T10:00:00Z'),
    ...overrides,
  };
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
      { slug: 'a', firstName: 'A', lastName: 'B', pronouns: null, avatarUrl: null },
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
  });

  it('moderator can delete + lock another member OP', () => {
    const dto = toForumThreadResponse(
      makeThread(),
      null,
      moderator,
      makePost({ authorId: 'author-1' }),
    );
    expect(dto.canDelete).toBe(true);
    expect(dto.canLock).toBe(true);
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

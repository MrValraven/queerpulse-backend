import { ForumPost } from './entities/forum-post.entity';
import { toForumPostResponse } from './forum-response';

function makePost(overrides: Partial<ForumPost> = {}): ForumPost {
  return {
    id: 'post-1',
    threadId: 'thread-1',
    authorId: 'author-1',
    body: 'hello',
    voteCount: 0,
    createdAt: new Date('2026-07-23T10:00:00Z'),
    editedAt: null,
    deletedAt: null,
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
      { slug: 'a', firstName: 'A', lastName: 'B', avatarUrl: null },
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

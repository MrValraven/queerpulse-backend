import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ForumPostsService } from './forum-posts.service';

// Minimal fake repositories; only the paths exercised below are stubbed.
function build() {
  const post = {
    id: 'p1',
    threadId: 't1',
    authorId: 'author-1',
    body: 'original',
    voteCount: 0,
    createdAt: new Date(),
    editedAt: null as Date | null,
    deletedAt: null as Date | null,
  };
  const posts = {
    findOne: jest.fn().mockResolvedValue(post),
    save: jest.fn().mockImplementation(async (p) => p),
  };
  const votes = { findOne: jest.fn().mockResolvedValue(null) };
  const edits = {
    create: jest.fn().mockImplementation((row) => row),
    save: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
  };
  const profiles = {} as never;
  const byUserIds = jest
    .spyOn(require('../common/member-ref').MemberLookup.prototype, 'byUserIds')
    .mockResolvedValue(new Map());
  const service = new ForumPostsService(
    posts as never,
    votes as never,
    profiles,
    { markActivity: jest.fn(), loadOr404: jest.fn() } as never,
    { excludeHidden: jest.fn() } as never,
    edits as never,
  );
  return { service, post, posts, edits, byUserIds };
}

const author = {
  userId: 'author-1',
  email: '',
  status: 'active',
  role: 'member',
};
const mod = { userId: 'mod-1', email: '', status: 'active', role: 'moderator' };
const stranger = { userId: 'x', email: '', status: 'active', role: 'member' };

describe('ForumPostsService authorization', () => {
  it('updatePostBody: non-author is forbidden', async () => {
    const { service } = build();
    await expect(
      service.updatePostBody('p1', mod, 'hack'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('updatePostBody: author snapshots a revision then edits', async () => {
    const { service, edits, posts } = build();
    await service.updatePostBody('p1', author, 'new body');
    expect(edits.save).toHaveBeenCalledWith(
      expect.objectContaining({
        previousBody: 'original',
        previousTitle: null,
      }),
    );
    expect(posts.save).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'new body', editedAt: expect.any(Date) }),
    );
  });

  it('updatePostBody: editing a deleted post 404s', async () => {
    const { service, post } = build();
    post.deletedAt = new Date();
    await expect(
      service.updatePostBody('p1', author, 'x'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('tombstonePost: moderator may delete another member post', async () => {
    const { service, posts } = build();
    await service.tombstonePost('p1', mod);
    expect(posts.save).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });

  it('tombstonePost: stranger is forbidden', async () => {
    const { service } = build();
    await expect(service.tombstonePost('p1', stranger)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('restorePost: clears the tombstone for staff', async () => {
    const { service, post, posts } = build();
    post.deletedAt = new Date();
    await service.restorePost('p1', mod);
    expect(posts.save).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: null }),
    );
  });
});

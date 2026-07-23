import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { CommunityPostsService } from './community-posts.service';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityPostEdit } from './entities/community-post-edit.entity';
import {
  CommunityPostReaction,
  ReactionKey,
} from './entities/community-post-reaction.entity';
import { CommunityPostReplyEdit } from './entities/community-post-reply-edit.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost, PostKind } from './entities/community-post.entity';
import {
  AccessTier,
  Community,
  CommunityType,
} from './entities/community.entity';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default (mirrors `communities.service.spec.ts`'s `qbStub`).
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

// The `.insert().into().values().orIgnore().execute()` chain used by
// `addReaction` (mirrors `EventsService.addCohost`'s idiom).
const insertQbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  qb.insert = jest.fn().mockReturnValue(qb);
  qb.into = jest.fn().mockReturnValue(qb);
  qb.values = jest.fn().mockReturnValue(qb);
  qb.orIgnore = jest.fn().mockReturnValue(qb);
  qb.execute = jest.fn().mockResolvedValue({ raw: [], generatedMaps: [] });
  return qb;
};

const COMMUNITY: Community = {
  id: 'c1',
  slug: 'queer-devs',
  name: 'Queer Devs',
  purpose: 'p',
  type: CommunityType.Professional,
  whoFor: 'w',
  tagline: 't',
  accessTier: AccessTier.Public,
  rosterVisible: true,
  features: [],
  rules: [],
  ownerId: 'owner-1',
  ref: 'QP-C-0001',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const POST: CommunityPost = {
  id: 'p1',
  communityId: 'c1',
  authorId: 'author-1',
  body: 'hello',
  image: null,
  kind: PostKind.Post,
  pinned: false,
  createdAt: new Date('2026-01-02T00:00:00.000Z'),
  editedAt: null,
  deletedAt: null,
};

const REPLY: CommunityPostReply = {
  id: 'r1',
  postId: 'p1',
  authorId: 'author-1',
  text: 'a reply',
  createdAt: new Date('2026-01-02T12:00:00.000Z'),
  editedAt: null,
  deletedAt: null,
};

describe('CommunityPostsService', () => {
  let service: CommunityPostsService;
  let communities: { findOne: jest.Mock };
  let members: { findOne: jest.Mock };
  let posts: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let reactions: {
    find: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let replies: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let profiles: { find: jest.Mock };
  let blockFilter: {
    excludeHidden: jest.Mock;
    hiddenUserIds: jest.Mock;
  };
  let postEdits: { create: jest.Mock; save: jest.Mock; find: jest.Mock };
  let replyEdits: { create: jest.Mock; save: jest.Mock; find: jest.Mock };

  beforeEach(async () => {
    communities = { findOne: jest.fn().mockResolvedValue(COMMUNITY) };
    members = { findOne: jest.fn().mockResolvedValue(null) };
    posts = {
      findOne: jest.fn().mockResolvedValue(POST),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) =>
        Promise.resolve({
          id: 'post-id',
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
          ...(v as object),
        }),
      ),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    reactions = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => insertQbStub()),
    };
    replies = {
      findOne: jest.fn().mockResolvedValue(REPLY),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) =>
        Promise.resolve({
          id: 'r1',
          ...(v as object),
          createdAt: new Date('2026-01-03T00:00:00.000Z'),
        }),
      ),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    blockFilter = {
      excludeHidden: jest.fn((qb: unknown) => qb),
      hiddenUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    postEdits = {
      create: jest.fn((v: object) => v),
      save: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
    };
    replyEdits = {
      create: jest.fn((v: object) => v),
      save: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityPostsService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        { provide: getRepositoryToken(CommunityPost), useValue: posts },
        {
          provide: getRepositoryToken(CommunityPostReaction),
          useValue: reactions,
        },
        { provide: getRepositoryToken(CommunityPostReply), useValue: replies },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: getRepositoryToken(CommunityPostEdit), useValue: postEdits },
        {
          provide: getRepositoryToken(CommunityPostReplyEdit),
          useValue: replyEdits,
        },
      ],
    }).compile();
    service = module.get(CommunityPostsService);
  });

  describe('createPost', () => {
    it('rejects a non-roster-member (403)', async () => {
      members.findOne.mockResolvedValue(null);
      await expect(
        service.createPost('queer-devs', 'stranger', { body: 'hi' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(posts.save).not.toHaveBeenCalled();
    });

    it('creates a post for a roster member', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      const res = await service.createPost('queer-devs', 'author-1', {
        body: 'hi there',
      });
      expect(posts.save).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 'c1',
          authorId: 'author-1',
          body: 'hi there',
          pinned: false,
        }),
      );
      expect(res.body).toBe('hi there');
      expect(res.reactions).toHaveLength(4);
      expect(res.replyCount).toBe(0);
    });

    it('404s an unknown community slug', async () => {
      communities.findOne.mockResolvedValue(null);
      await expect(
        service.createPost('nope', 'u1', { body: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('addReaction', () => {
    it('rejects a non-member', async () => {
      members.findOne.mockResolvedValue(null);
      await expect(
        service.addReaction('queer-devs', 'p1', 'stranger', ReactionKey.Heart),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('inserts idempotently via ON CONFLICT DO NOTHING (orIgnore)', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      const qb = insertQbStub();
      reactions.createQueryBuilder.mockReturnValue(qb);

      await service.addReaction('queer-devs', 'p1', 'u1', ReactionKey.Heart);

      expect(qb.insert).toHaveBeenCalled();
      expect(qb.into).toHaveBeenCalledWith(CommunityPostReaction);
      expect(qb.values).toHaveBeenCalledWith({
        postId: 'p1',
        userId: 'u1',
        key: ReactionKey.Heart,
      });
      expect(qb.orIgnore).toHaveBeenCalled();
      expect(qb.execute).toHaveBeenCalled();
    });

    it('re-reacting does not change the persisted count (DB dedups on the unique key)', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      // Simulate the post-insert DB state: exactly one row regardless of how
      // many times `addReaction` was called for the same (post,user,key).
      reactions.find.mockResolvedValue([
        { key: ReactionKey.Heart, userId: 'u1' },
      ]);

      await service.addReaction('queer-devs', 'p1', 'u1', ReactionKey.Heart);
      const second = await service.addReaction(
        'queer-devs',
        'p1',
        'u1',
        ReactionKey.Heart,
      );

      const heart = second.reactions.find((r) => r.key === ReactionKey.Heart);
      expect(heart?.count).toBe(1);
      expect(heart?.mine).toBe(true);
    });
  });

  describe('reaction summary', () => {
    it('returns all 4 keys with count + mine for the viewer', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      reactions.find.mockResolvedValue([
        { key: ReactionKey.Heart, userId: 'someone-else' },
        { key: ReactionKey.Heart, userId: 'viewer' },
        { key: ReactionKey.Fire, userId: 'someone-else' },
      ]);

      const res = await service.addReaction(
        'queer-devs',
        'p1',
        'viewer',
        ReactionKey.Heart,
      );

      expect(res.reactions).toHaveLength(4);
      expect(res.reactions.map((r) => r.key).sort()).toEqual(
        [
          ReactionKey.Celebrate,
          ReactionKey.Fire,
          ReactionKey.Heart,
          ReactionKey.Support,
        ].sort(),
      );
      const heart = res.reactions.find((r) => r.key === ReactionKey.Heart);
      expect(heart).toEqual({ key: ReactionKey.Heart, count: 2, mine: true });
      const fire = res.reactions.find((r) => r.key === ReactionKey.Fire);
      expect(fire).toEqual({ key: ReactionKey.Fire, count: 1, mine: false });
      const support = res.reactions.find((r) => r.key === ReactionKey.Support);
      expect(support).toEqual({
        key: ReactionKey.Support,
        count: 0,
        mine: false,
      });
    });
  });

  describe('removeReaction', () => {
    it('rejects a non-member', async () => {
      members.findOne.mockResolvedValue(null);
      await expect(
        service.removeReaction(
          'queer-devs',
          'p1',
          'stranger',
          ReactionKey.Heart,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('deletes by (post,user,key) for a member', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      await service.removeReaction('queer-devs', 'p1', 'u1', ReactionKey.Fire);
      expect(reactions.delete).toHaveBeenCalledWith({
        postId: 'p1',
        userId: 'u1',
        key: ReactionKey.Fire,
      });
    });
  });

  describe('updatePost', () => {
    it('rejects an actor who is not a roster member at all', async () => {
      members.findOne.mockResolvedValue(null);
      await expect(
        service.updatePost('queer-devs', 'p1', 'stranger', { body: 'new' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects pinning by a plain member (mod required)', async () => {
      // Even the post's own author can't pin without a mod/owner role.
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      await expect(
        service.updatePost('queer-devs', 'p1', 'author-1', { pinned: true }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(posts.save).not.toHaveBeenCalled();
    });

    it('allows a mod to pin a post they did not author', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Mod });
      const res = await service.updatePost('queer-devs', 'p1', 'mod-1', {
        pinned: true,
      });
      expect(posts.save).toHaveBeenCalledWith(
        expect.objectContaining({ pinned: true }),
      );
      expect(res.pinned).toBe(true);
    });

    it('rejects a body/kind edit from a mod who is not the author', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Mod });
      await expect(
        service.updatePost('queer-devs', 'p1', 'mod-1', { body: 'edited' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows the author to edit body/kind', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      const res = await service.updatePost('queer-devs', 'p1', 'author-1', {
        body: 'edited',
      });
      expect(posts.save).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'edited' }),
      );
      expect(res.body).toBe('edited');
    });

    it('404s an unknown post id within the community', async () => {
      posts.findOne.mockResolvedValue(null);
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      await expect(
        service.updatePost('queer-devs', 'missing', 'author-1', {
          body: 'x',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('snapshots a community_post_edit revision (with the pre-edit body) before mutating the body, and stamps editedAt', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      const res = await service.updatePost('queer-devs', 'p1', 'author-1', {
        body: 'edited body',
      });
      expect(postEdits.save).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: 'p1',
          previousBody: 'hello', // POST.body, captured before the mutation
          editorId: 'author-1',
        }),
      );
      expect(posts.save).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'edited body',
          editedAt: expect.any(Date),
        }),
      );
      expect(res.editedAt).not.toBeNull();
    });

    it('does not snapshot a revision when the body is unchanged (kind-only edit)', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      await service.updatePost('queer-devs', 'p1', 'author-1', {
        kind: PostKind.Announcement,
      });
      expect(postEdits.save).not.toHaveBeenCalled();
    });
  });

  describe('deletePost / restorePost / listPostHistory', () => {
    it('deletePost rejects a plain member who is not the author', async () => {
      members.findOne.mockResolvedValue({
        userId: 'stranger',
        role: RosterRole.Member,
      });
      await expect(
        service.deletePost('queer-devs', 'p1', 'stranger'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(posts.save).not.toHaveBeenCalled();
    });

    it('deletePost allows the author to tombstone their own post', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      const res = await service.deletePost('queer-devs', 'p1', 'author-1');
      expect(posts.save).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: expect.any(Date) }),
      );
      expect(res.deleted).toBe(true);
    });

    it('deletePost allows a community mod to tombstone another member post', async () => {
      members.findOne.mockResolvedValue({
        userId: 'mod-1',
        role: RosterRole.Mod,
      });
      await service.deletePost('queer-devs', 'p1', 'mod-1');
      expect(posts.save).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: expect.any(Date) }),
      );
    });

    it('deletePost is idempotent — a second delete does not re-save', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      posts.findOne.mockResolvedValue({ ...POST, deletedAt: new Date() });
      await service.deletePost('queer-devs', 'p1', 'author-1');
      expect(posts.save).not.toHaveBeenCalled();
    });

    it('restorePost allows the author to clear their own tombstone', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      posts.findOne.mockResolvedValue({ ...POST, deletedAt: new Date() });
      const res = await service.restorePost('queer-devs', 'p1', 'author-1');
      expect(posts.save).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: null }),
      );
      expect(res.deleted).toBe(false);
    });

    it('restorePost rejects a plain member who is not the author', async () => {
      members.findOne.mockResolvedValue({
        userId: 'stranger',
        role: RosterRole.Member,
      });
      posts.findOne.mockResolvedValue({ ...POST, deletedAt: new Date() });
      await expect(
        service.restorePost('queer-devs', 'p1', 'stranger'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(posts.save).not.toHaveBeenCalled();
    });

    it('restorePost is idempotent — restoring a live post does not re-save', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      await service.restorePost('queer-devs', 'p1', 'author-1');
      expect(posts.save).not.toHaveBeenCalled();
    });

    it('listPostHistory returns revisions newest-first for the author', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      postEdits.find.mockResolvedValue([
        {
          id: 'edit-2',
          postId: 'p1',
          previousBody: 'second-to-last body',
          editorId: 'author-1',
          createdAt: new Date('2026-01-03T00:00:00.000Z'),
        },
        {
          id: 'edit-1',
          postId: 'p1',
          previousBody: 'original body',
          editorId: 'author-1',
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ]);

      const res = await service.listPostHistory('queer-devs', 'p1', 'author-1');

      expect(postEdits.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { postId: 'p1' },
          order: { createdAt: 'DESC' },
        }),
      );
      expect(res.revisions.map((r) => r.id)).toEqual(['edit-2', 'edit-1']);
      expect(res.revisions[0].previousBody).toBe('second-to-last body');
    });

    it('listPostHistory rejects a plain member who is not the author', async () => {
      members.findOne.mockResolvedValue({
        userId: 'stranger',
        role: RosterRole.Member,
      });
      await expect(
        service.listPostHistory('queer-devs', 'p1', 'stranger'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listPostHistory allows a community owner to view another member post history', async () => {
      members.findOne.mockResolvedValue({
        userId: 'owner-1',
        role: RosterRole.Owner,
      });
      await expect(
        service.listPostHistory('queer-devs', 'p1', 'owner-1'),
      ).resolves.toEqual({ revisions: [] });
    });
  });

  describe('addReply', () => {
    it('rejects a non-member', async () => {
      members.findOne.mockResolvedValue(null);
      await expect(
        service.addReply('queer-devs', 'p1', 'stranger', 'hi'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(replies.save).not.toHaveBeenCalled();
    });

    it('creates a reply for a roster member', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      profiles.find.mockResolvedValue([
        {
          userId: 'u1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      const res = await service.addReply('queer-devs', 'p1', 'u1', 'hi!');

      expect(replies.save).toHaveBeenCalledWith(
        expect.objectContaining({ postId: 'p1', authorId: 'u1', text: 'hi!' }),
      );
      expect(res.text).toBe('hi!');
      expect(res.author).toEqual(
        expect.objectContaining({ slug: 'jo', firstName: 'Jo' }),
      );
    });
  });

  describe('updateReply / deleteReply / restoreReply / listReplyHistory', () => {
    it('updateReply rejects a non-author (edit is author-only, not owner/mod)', async () => {
      members.findOne.mockResolvedValue({
        userId: 'mod-1',
        role: RosterRole.Mod,
      });
      await expect(
        service.updateReply('queer-devs', 'p1', 'r1', 'mod-1', 'edited'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(replies.save).not.toHaveBeenCalled();
    });

    it('updateReply snapshots a community_post_reply_edit revision before mutating the text, and stamps editedAt', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      const res = await service.updateReply(
        'queer-devs',
        'p1',
        'r1',
        'author-1',
        'edited reply',
      );
      expect(replyEdits.save).toHaveBeenCalledWith(
        expect.objectContaining({
          replyId: 'r1',
          previousText: 'a reply', // REPLY.text, captured before the mutation
          editorId: 'author-1',
        }),
      );
      expect(replies.save).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'edited reply',
          editedAt: expect.any(Date),
        }),
      );
      expect(res.editedAt).not.toBeNull();
    });

    it('updateReply 404s a deleted reply', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      replies.findOne.mockResolvedValue({ ...REPLY, deletedAt: new Date() });
      await expect(
        service.updateReply('queer-devs', 'p1', 'r1', 'author-1', 'edited'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deleteReply rejects a plain member who is not the author', async () => {
      members.findOne.mockResolvedValue({
        userId: 'stranger',
        role: RosterRole.Member,
      });
      await expect(
        service.deleteReply('queer-devs', 'p1', 'r1', 'stranger'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(replies.save).not.toHaveBeenCalled();
    });

    it('deleteReply allows a community mod to tombstone another member reply', async () => {
      members.findOne.mockResolvedValue({
        userId: 'mod-1',
        role: RosterRole.Mod,
      });
      const res = await service.deleteReply('queer-devs', 'p1', 'r1', 'mod-1');
      expect(replies.save).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: expect.any(Date) }),
      );
      expect(res.deleted).toBe(true);
    });

    it('deleteReply is idempotent — a second delete does not re-save', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      replies.findOne.mockResolvedValue({ ...REPLY, deletedAt: new Date() });
      await service.deleteReply('queer-devs', 'p1', 'r1', 'author-1');
      expect(replies.save).not.toHaveBeenCalled();
    });

    it('restoreReply allows the author to clear their own tombstone', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      replies.findOne.mockResolvedValue({ ...REPLY, deletedAt: new Date() });
      const res = await service.restoreReply(
        'queer-devs',
        'p1',
        'r1',
        'author-1',
      );
      expect(replies.save).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: null }),
      );
      expect(res.deleted).toBe(false);
    });

    it('listReplyHistory rejects a plain member who is not the author', async () => {
      members.findOne.mockResolvedValue({
        userId: 'stranger',
        role: RosterRole.Member,
      });
      await expect(
        service.listReplyHistory('queer-devs', 'p1', 'r1', 'stranger'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listReplyHistory returns revisions newest-first, tolerating a null editorId', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      replyEdits.find.mockResolvedValue([
        {
          id: 'redit-2',
          replyId: 'r1',
          previousText: 'second-to-last text',
          editorId: null,
          createdAt: new Date('2026-01-03T00:00:00.000Z'),
        },
        {
          id: 'redit-1',
          replyId: 'r1',
          previousText: 'original text',
          editorId: 'author-1',
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ]);

      const res = await service.listReplyHistory(
        'queer-devs',
        'p1',
        'r1',
        'author-1',
      );

      expect(replyEdits.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { replyId: 'r1' },
          order: { createdAt: 'DESC' },
        }),
      );
      expect(res.revisions.map((r) => r.id)).toEqual(['redit-2', 'redit-1']);
      expect(res.revisions[0].author).toBeNull();
    });
  });

  describe('listPosts', () => {
    it('orders pinned first, then newest', async () => {
      const qb = qbStub();
      posts.createQueryBuilder.mockReturnValue(qb);

      await service.listPosts('queer-devs', 'u1');

      expect(qb.orderBy).toHaveBeenCalledWith('p.pinned', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('p.created_at', 'DESC');
    });

    // In-query so that both the LIMIT/OFFSET page and `total` count only
    // visible posts — filtering the fetched rows would report a `total` the
    // caller can never page through.
    it('excludes blocked/muted authors in-query, keyed on the author column', async () => {
      const qb = qbStub();
      posts.createQueryBuilder.mockReturnValue(qb);

      await service.listPosts('queer-devs', 'u1');

      expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
        qb,
        'u1',
        '"p"."author_id"',
      );
    });

    // Replies are a nested, unpaginated collection, so post-query filtering is
    // safe here — there is no page length to under-fill.
    it('drops nested replies whose author is blocked or muted', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([
        [{ ...POST, id: 'post-id', authorId: 'u1' }],
        1,
      ]);
      posts.createQueryBuilder.mockReturnValue(qb);
      replies.find.mockResolvedValue([
        { id: 'r1', postId: 'post-id', authorId: 'blocked-1', text: 'hi' },
        { id: 'r2', postId: 'post-id', authorId: 'ok-1', text: 'hello' },
      ]);
      blockFilter.hiddenUserIds.mockResolvedValue(new Set(['blocked-1']));

      const page = await service.listPosts('queer-devs', 'u1');

      expect(page.items[0].replies.map((r) => r.id)).toEqual(['r2']);
    });

    it("404s a private community's feed for a non-member", async () => {
      communities.findOne.mockResolvedValue({
        ...COMMUNITY,
        accessTier: AccessTier.Private,
      });
      members.findOne.mockResolvedValue(null);
      await expect(
        service.listPosts('queer-devs', 'stranger'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // --- flat aliases (`POST /community-posts*`) ---

  describe('createFlatPost', () => {
    it('creates a global post (no communitySlug) without touching community/member lookups', async () => {
      const res = await service.createFlatPost('u1', { body: 'hello world' });

      expect(communities.findOne).not.toHaveBeenCalled();
      expect(members.findOne).not.toHaveBeenCalled();
      expect(posts.save).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: null,
          authorId: 'u1',
          body: 'hello world',
        }),
      );
      expect(res).toEqual({ id: 'post-id' });
    });

    it('creates a post scoped to a community when communitySlug is given', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Member });

      const res = await service.createFlatPost('author-1', {
        body: 'hi there',
        communitySlug: 'queer-devs',
      });

      expect(communities.findOne).toHaveBeenCalled();
      expect(posts.save).toHaveBeenCalledWith(
        expect.objectContaining({ communityId: 'c1', authorId: 'author-1' }),
      );
      expect(res).toEqual({ id: 'post-id' });
    });

    it('rejects a non-roster-member posting into a specific community', async () => {
      members.findOne.mockResolvedValue(null);
      await expect(
        service.createFlatPost('stranger', {
          body: 'hi',
          communitySlug: 'queer-devs',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(posts.save).not.toHaveBeenCalled();
    });

    it('404s an unknown communitySlug', async () => {
      communities.findOne.mockResolvedValue(null);
      await expect(
        service.createFlatPost('u1', { body: 'x', communitySlug: 'nope' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('likeFlatPost', () => {
    it('likes a community-scoped post as a roster member, via the reserved Like key', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      const qb = insertQbStub();
      reactions.createQueryBuilder.mockReturnValue(qb);
      reactions.count.mockResolvedValue(3);

      const res = await service.likeFlatPost('p1', 'u1', true);

      expect(qb.insert).toHaveBeenCalled();
      expect(qb.values).toHaveBeenCalledWith({
        postId: 'p1',
        userId: 'u1',
        key: ReactionKey.Like,
      });
      expect(reactions.count).toHaveBeenCalledWith({
        where: { postId: 'p1', key: ReactionKey.Like },
      });
      expect(res).toEqual({ liked: true, likeCount: 3 });
    });

    it('unlikes by deleting the (post,user,Like) row', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      reactions.count.mockResolvedValue(0);

      const res = await service.likeFlatPost('p1', 'u1', false);

      expect(reactions.delete).toHaveBeenCalledWith({
        postId: 'p1',
        userId: 'u1',
        key: ReactionKey.Like,
      });
      expect(res).toEqual({ liked: false, likeCount: 0 });
    });

    it('rejects a non-roster-member liking a community-scoped post', async () => {
      members.findOne.mockResolvedValue(null);
      await expect(
        service.likeFlatPost('p1', 'stranger', true),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets any active member like a global post (no community roster to check)', async () => {
      posts.findOne.mockResolvedValue({ ...POST, communityId: null });
      members.findOne.mockResolvedValue(null); // would 403 if a roster check ran

      const res = await service.likeFlatPost('p1', 'u1', true);

      expect(members.findOne).not.toHaveBeenCalled();
      expect(res.liked).toBe(true);
    });

    it('404s an unknown post id', async () => {
      posts.findOne.mockResolvedValue(null);
      await expect(
        service.likeFlatPost('missing', 'u1', true),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('addFlatReply', () => {
    it('rejects a non-roster-member replying to a community-scoped post', async () => {
      members.findOne.mockResolvedValue(null);
      await expect(
        service.addFlatReply('p1', 'stranger', 'hi'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(replies.save).not.toHaveBeenCalled();
    });

    it('replies to a community-scoped post as a roster member', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Member });

      const res = await service.addFlatReply('p1', 'u1', 'hi!');

      expect(replies.save).toHaveBeenCalledWith(
        expect.objectContaining({ postId: 'p1', authorId: 'u1', text: 'hi!' }),
      );
      expect(res).toEqual({ id: 'r1' });
    });

    it('lets any active member reply to a global post (no community roster to check)', async () => {
      posts.findOne.mockResolvedValue({ ...POST, communityId: null });
      members.findOne.mockResolvedValue(null); // would 403 if a roster check ran

      const res = await service.addFlatReply('p1', 'u1', 'hi!');

      expect(members.findOne).not.toHaveBeenCalled();
      expect(res).toEqual({ id: 'r1' });
    });

    it('404s an unknown post id', async () => {
      posts.findOne.mockResolvedValue(null);
      await expect(
        service.addFlatReply('missing', 'u1', 'hi'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

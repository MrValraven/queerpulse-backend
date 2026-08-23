import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { BlockFilterService } from '../social/block-filter.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { StorageService } from '../storage/storage.service';
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
import { Report } from '../reports/entities/report.entity';

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

// Chainable stub for `listCommunityReports`'s `reports.createQueryBuilder()`
// (`select`-less; terminal `getMany`, default empty).
const reportsQbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['select', 'where', 'andWhere', 'orderBy', 'take']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue([]);
  return qb;
};

// The `.insert().into().values().orIgnore().execute()` chain used by
// `addReaction` (mirrors `EventsService.addCohost`'s idiom). Also carries the
// `select/groupBy/getRawMany` chain, because `addReaction`/`likeFlatPost`
// reuse this SAME mocked `createQueryBuilder` return value for the
// `reactionAggregatesByPost` aggregate query that runs afterward while
// building the returned post DTO.
const insertQbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  qb.insert = jest.fn().mockReturnValue(qb);
  qb.into = jest.fn().mockReturnValue(qb);
  qb.values = jest.fn().mockReturnValue(qb);
  qb.orIgnore = jest.fn().mockReturnValue(qb);
  qb.execute = jest.fn().mockResolvedValue({ raw: [], generatedMaps: [] });
  for (const m of ['select', 'addSelect', 'where', 'groupBy', 'addGroupBy']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  return qb;
};

// A raw-query-builder stub for the aggregate / `ROW_NUMBER()` window queries
// behind `topRepliesByPost`/`replyCountByPost`/`reactionAggregatesByPost`
// (terminal `getRawMany()`, default empty). `.from()` invokes its subquery
// callback (if given one) against a fresh stub of the same shape, so
// `blockFilter.excludeHidden` still gets exercised on the inner builder,
// mirroring the real subquery `topRepliesByPost` builds.
const rawQbStub = (rows: unknown[] = []) => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'addOrderBy',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.from = jest.fn((arg: unknown) => {
    // `.from()` has two forms: `.from(subQueryCallback, alias)` and
    // `.from(EntityClass, alias)`. Both an arrow callback and an entity class
    // are `typeof === 'function'`, so distinguish them: only an arrow
    // subquery callback (no `prototype`) should be invoked. An entity class
    // (e.g. `CommunityPostReply`) has a `prototype` and would otherwise be
    // called without `new` — the "cannot be invoked without 'new'" throw.
    if (typeof arg === 'function' && !('prototype' in arg)) {
      (arg as (sub: Record<string, jest.Mock>) => unknown)(rawQbStub());
    }
    return qb;
  });
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
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
  requiresSecondVouch: false,
  autoFreezeOnReports: false,
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
  isFeatured: false,
  needsOwnerReviewAt: null,
  frozenReason: null,
  frozenNote: null,
  frozenByUserId: null,
  rulesVersion: 1,
  welcomeMessage: null,
  avatarImageUrl: null,
  city: null,
  area: null,
  isOnline: false,
  languages: [],
  activeThisWeek: 0,
  activityCountedAt: null,
  isPubliclyListed: false,
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
  // Live post, so nobody set a tombstone (BE-COM-01). `assertCanRestore`
  // reads this column, and `undefined` would be judged as "someone else
  // deleted it" rather than "not tombstoned".
  deletedById: null,
};

const REPLY: CommunityPostReply = {
  id: 'r1',
  postId: 'p1',
  authorId: 'author-1',
  text: 'a reply',
  createdAt: new Date('2026-01-02T12:00:00.000Z'),
  editedAt: null,
  deletedAt: null,
  deletedById: null,
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
    manager: { transaction: jest.Mock };
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
    createQueryBuilder: jest.Mock;
    manager: { createQueryBuilder: jest.Mock };
  };
  let profiles: { find: jest.Mock };
  let blockFilter: {
    excludeHidden: jest.Mock;
    hiddenUserIds: jest.Mock;
  };
  let postEdits: { create: jest.Mock; save: jest.Mock; find: jest.Mock };
  let replyEdits: { create: jest.Mock; save: jest.Mock; find: jest.Mock };
  let mentions: { notify: jest.Mock; notifyPostReply: jest.Mock };
  // `statesForAnyType` returns an empty map by default (every subject falls
  // back to `CommunityPostsService.VISIBLE`); `excludeHidden` is a pass-through
  // on the query builder, mirroring the `blockFilter` stub above — the real
  // in-SQL exclusion is exercised against a live DB in e2e, not here.
  let contentModeration: {
    statesForAnyType: jest.Mock;
    excludeHidden: jest.Mock;
  };
  let storage: { deleteObjectByReference: jest.Mock };
  // `listCommunityReports`'s open-report query (`createQueryBuilder`, default
  // empty) — the `posts`/`replies` repos it also reads from are the same
  // mocks every other test in this file already sets up.
  let reports: { createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    communities = { findOne: jest.fn().mockResolvedValue(COMMUNITY) };
    members = { findOne: jest.fn().mockResolvedValue(null) };
    posts = {
      // Fresh clone per call: the service mutates the resolved post in place
      // (body/pinned/editedAt/deletedAt), so returning the shared `POST`
      // reference would leak those mutations across tests.
      findOne: jest.fn(() => Promise.resolve({ ...POST })),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) =>
        Promise.resolve({
          id: 'post-id',
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
          ...(v as object),
        }),
      ),
      createQueryBuilder: jest.fn(() => qbStub()),
      // `updatePost` now persists the edit snapshot + the mutated post together
      // inside `posts.manager.transaction`. The stub runs the callback
      // synchronously and routes each `manager.save(row)` to the same repo mock
      // the assertions target: the pre-edit snapshot (it carries `previousBody`)
      // to `postEdits.save`, everything else (the post) to `posts.save`.
      manager: {
        transaction: jest.fn(
          async (
            callback: (managerLike: {
              save: (row: Record<string, unknown>) => unknown;
            }) => Promise<unknown>,
          ) =>
            callback({
              save: (row: Record<string, unknown>): unknown =>
                'previousBody' in row ? postEdits.save(row) : posts.save(row),
            }),
        ),
      },
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
      // `replyCountByPost`'s `GROUP BY post_id` aggregate — default empty
      // (no replies), matching the old `find.mockResolvedValue([])` default.
      createQueryBuilder: jest.fn(() => rawQbStub()),
      // `topRepliesByPost`'s `ROW_NUMBER()` window subquery — default empty.
      manager: { createQueryBuilder: jest.fn(() => rawQbStub()) },
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
    // `notify` resolves to the Set of @mentioned user ids the caller checks
    // (`if (!mentioned.has(post.authorId))`) before firing the reply-notify;
    // default empty so the post-author notification always runs.
    mentions = {
      notify: jest.fn().mockResolvedValue(new Set<string>()),
      notifyPostReply: jest.fn().mockResolvedValue(undefined),
    };
    contentModeration = {
      statesForAnyType: jest.fn().mockResolvedValue(new Map()),
      excludeHidden: jest.fn((qb: unknown) => qb),
    };
    storage = {
      deleteObjectByReference: jest.fn().mockResolvedValue(undefined),
    };
    reports = { createQueryBuilder: jest.fn(() => reportsQbStub()) };

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
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: MentionNotificationService, useValue: mentions },
        { provide: ContentModerationService, useValue: contentModeration },
        { provide: StorageService, useValue: storage },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
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
      // `reactionAggregatesByPost` reads this via the SAME mocked
      // `createQueryBuilder` return value the insert chain uses (see
      // `insertQbStub`'s doc comment).
      const qb = insertQbStub();
      qb.getRawMany!.mockResolvedValue([
        { postId: 'p1', key: ReactionKey.Heart, count: '1' },
      ]);
      reactions.createQueryBuilder.mockReturnValue(qb);
      reactions.find.mockResolvedValue([
        { postId: 'p1', key: ReactionKey.Heart },
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
      // Two Heart reactions (someone-else + viewer), one Fire (someone-else
      // only) — `reactionAggregatesByPost`'s `GROUP BY` count plus the
      // viewer-scoped "mine" lookup, not the raw per-user rows.
      const qb = insertQbStub();
      qb.getRawMany!.mockResolvedValue([
        { postId: 'p1', key: ReactionKey.Heart, count: '2' },
        { postId: 'p1', key: ReactionKey.Fire, count: '1' },
      ]);
      reactions.createQueryBuilder.mockReturnValue(qb);
      reactions.find.mockResolvedValue([
        { postId: 'p1', key: ReactionKey.Heart },
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
          editedAt: expect.any(Date) as unknown,
        }),
      );
      expect(res.editedAt).not.toBeNull();
    });

    // BE-COM-16: `announcement` reads as the community's official voice, so
    // it is owner/mod-only on edit as well as on create — an author could
    // otherwise post a plain `post` and immediately PATCH it into a staff
    // announcement. The actor here is therefore the post's author AND a mod.
    it('does not snapshot a revision when the body is unchanged (kind-only edit)', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Mod,
      });
      await service.updatePost('queer-devs', 'p1', 'author-1', {
        kind: PostKind.Announcement,
      });
      expect(postEdits.save).not.toHaveBeenCalled();
    });

    it('rejects a plain member promoting their own post to an announcement', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      await expect(
        service.updatePost('queer-devs', 'p1', 'author-1', {
          kind: PostKind.Announcement,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(posts.save).not.toHaveBeenCalled();
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
      // The tombstone records WHO set it — `assertCanRestore` reads it to
      // tell an author's own delete apart from a moderator takedown.
      expect(posts.save).toHaveBeenCalledWith(
        expect.objectContaining({
          deletedAt: expect.any(Date) as unknown,
          deletedById: 'author-1',
        }),
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
        expect.objectContaining({
          deletedAt: expect.any(Date) as unknown,
          deletedById: 'mod-1',
        }),
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

    it('restorePost allows the author to clear a tombstone they set themselves', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      posts.findOne.mockResolvedValue({
        ...POST,
        deletedAt: new Date(),
        deletedById: 'author-1',
      });
      const res = await service.restorePost('queer-devs', 'p1', 'author-1');
      // The actor marker is cleared with the tombstone, so a later
      // delete/restore pair is judged on its own actor.
      expect(posts.save).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: null, deletedById: null }),
      );
      expect(res.deleted).toBe(false);
    });

    // BE-COM-01: delete and restore used to share one author-OR-owner/mod
    // check, so the author of a post a community moderator had removed simply
    // undid the removal — community moderation via the delete button was
    // cosmetic. A tombstone may now only be cleared by the actor who SET it,
    // or by the community's owner/mod.
    it('restorePost refuses to let the author undo a moderator tombstone', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      posts.findOne.mockResolvedValue({
        ...POST,
        deletedAt: new Date(),
        deletedById: 'mod-1',
      });
      await expect(
        service.restorePost('queer-devs', 'p1', 'author-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(posts.save).not.toHaveBeenCalled();
    });

    it('restorePost lets an owner/mod lift a tombstone somebody else set', async () => {
      members.findOne.mockResolvedValue({
        userId: 'mod-2',
        role: RosterRole.Mod,
      });
      posts.findOne.mockResolvedValue({
        ...POST,
        deletedAt: new Date(),
        deletedById: 'mod-1',
      });
      await service.restorePost('queer-devs', 'p1', 'mod-2');
      expect(posts.save).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: null, deletedById: null }),
      );
    });

    // A tombstone written before `AddContentTombstoneActor1793520000000` has
    // no actor to compare against, so restore falls back to the caller's own
    // author-or-staff check rather than locking legacy content out entirely.
    it('restorePost still lets the author clear a legacy (actor-less) tombstone', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      posts.findOne.mockResolvedValue({
        ...POST,
        deletedAt: new Date(),
        deletedById: null,
      });
      await service.restorePost('queer-devs', 'p1', 'author-1');
      expect(posts.save).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: null }),
      );
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
      expect(res.revisions[0]!.previousBody).toBe('second-to-last body');
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
          editedAt: expect.any(Date) as unknown,
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
        expect.objectContaining({ deletedAt: expect.any(Date) as unknown }),
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

    it('restoreReply allows the author to clear a tombstone they set themselves', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      replies.findOne.mockResolvedValue({
        ...REPLY,
        deletedAt: new Date(),
        deletedById: 'author-1',
      });
      const res = await service.restoreReply(
        'queer-devs',
        'p1',
        'r1',
        'author-1',
      );
      expect(replies.save).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: null, deletedById: null }),
      );
      expect(res.deleted).toBe(false);
    });

    // Same BE-COM-01 rule as `restorePost`, on the reply tier.
    it('restoreReply refuses to let the author undo a moderator tombstone', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      replies.findOne.mockResolvedValue({
        ...REPLY,
        deletedAt: new Date(),
        deletedById: 'mod-1',
      });
      await expect(
        service.restoreReply('queer-devs', 'p1', 'r1', 'author-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(replies.save).not.toHaveBeenCalled();
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
      expect(res.revisions[0]!.author).toBeNull();
    });
  });

  // `assertNotFrozen` gates new posts/replies/reactions while a community is
  // auto-frozen pending report review (`Community.frozenAt`) — owner/mod are
  // exempt so they can still post a note and moderate (verified against the
  // actual gate below, not assumed); reads and edits/deletes of existing
  // content are unaffected by freezing and so aren't covered here.
  describe('frozen community — assertNotFrozen gate', () => {
    const FROZEN_COMMUNITY: Community = {
      ...COMMUNITY,
      frozenAt: new Date('2026-01-05T00:00:00.000Z'),
    };

    it('rejects a new post from a plain member while frozen', async () => {
      communities.findOne.mockResolvedValue(FROZEN_COMMUNITY);
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      await expect(
        service.createPost('queer-devs', 'u1', { body: 'hi' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(posts.save).not.toHaveBeenCalled();
    });

    it('allows the owner to post while frozen', async () => {
      communities.findOne.mockResolvedValue(FROZEN_COMMUNITY);
      members.findOne.mockResolvedValue({ role: RosterRole.Owner });
      const res = await service.createPost('queer-devs', 'owner-1', {
        body: 'a note from the owner',
      });
      expect(res.body).toBe('a note from the owner');
    });

    it('allows a mod to post while frozen', async () => {
      communities.findOne.mockResolvedValue(FROZEN_COMMUNITY);
      members.findOne.mockResolvedValue({ role: RosterRole.Mod });
      const res = await service.createPost('queer-devs', 'mod-1', {
        body: 'a note from a mod',
      });
      expect(res.body).toBe('a note from a mod');
    });

    it('rejects a new reply from a plain member while frozen', async () => {
      communities.findOne.mockResolvedValue(FROZEN_COMMUNITY);
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      await expect(
        service.addReply('queer-devs', 'p1', 'u1', 'hi'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(replies.save).not.toHaveBeenCalled();
    });

    it('allows an owner/mod to reply while frozen', async () => {
      communities.findOne.mockResolvedValue(FROZEN_COMMUNITY);
      members.findOne.mockResolvedValue({ role: RosterRole.Mod });
      const res = await service.addReply(
        'queer-devs',
        'p1',
        'mod-1',
        'moderator note',
      );
      expect(res.text).toBe('moderator note');
    });

    it('rejects a new reaction from a plain member while frozen', async () => {
      communities.findOne.mockResolvedValue(FROZEN_COMMUNITY);
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      await expect(
        service.addReaction('queer-devs', 'p1', 'u1', ReactionKey.Heart),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows the owner to react while frozen', async () => {
      communities.findOne.mockResolvedValue(FROZEN_COMMUNITY);
      members.findOne.mockResolvedValue({ role: RosterRole.Owner });
      const qb = insertQbStub();
      reactions.createQueryBuilder.mockReturnValue(qb);

      await service.addReaction(
        'queer-devs',
        'p1',
        'owner-1',
        ReactionKey.Heart,
      );

      expect(qb.execute).toHaveBeenCalled();
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

    // The DTO flag mirrors `assertCanRestore` so the restore button is absent
    // rather than 403-ing on click (BE-COM-01).
    it('canRestore is false for the author of a post a moderator tombstoned', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      const qb = qbStub();
      qb.getManyAndCount!.mockResolvedValue([
        [
          {
            ...POST,
            deletedAt: new Date('2026-02-01T00:00:00.000Z'),
            deletedById: 'mod-1',
          },
        ],
        1,
      ]);
      posts.createQueryBuilder.mockReturnValue(qb);

      const page = await service.listPosts('queer-devs', 'author-1');

      expect(page.items[0]!.deleted).toBe(true);
      expect(page.items[0]!.canRestore).toBe(false);
    });

    it('canRestore is true for the author of a tombstone they set themselves', async () => {
      members.findOne.mockResolvedValue({
        userId: 'author-1',
        role: RosterRole.Member,
      });
      const qb = qbStub();
      qb.getManyAndCount!.mockResolvedValue([
        [
          {
            ...POST,
            deletedAt: new Date('2026-02-01T00:00:00.000Z'),
            deletedById: 'author-1',
          },
        ],
        1,
      ]);
      posts.createQueryBuilder.mockReturnValue(qb);

      const page = await service.listPosts('queer-devs', 'author-1');

      expect(page.items[0]!.canRestore).toBe(true);
    });

    // Blocked/muted reply authors are excluded IN-QUERY by
    // `topRepliesByPost`'s inner subquery (mirrors `listPosts`'s own posts
    // filter), so a bounded reply preview fills with visible rows instead of
    // coming back short — only what the real DB WHERE would ever return is
    // stubbed here (`blocked-1`'s reply never comes back at all).
    it('excludes blocked/muted reply authors in-query, keyed on the reply author column', async () => {
      const qb = qbStub();
      qb.getManyAndCount!.mockResolvedValue([
        [{ ...POST, id: 'post-id', authorId: 'u1' }],
        1,
      ]);
      posts.createQueryBuilder.mockReturnValue(qb);
      replies.manager.createQueryBuilder.mockReturnValue(
        rawQbStub([
          {
            id: 'r2',
            postId: 'post-id',
            authorId: 'ok-1',
            text: 'hello',
            createdAt: new Date('2026-01-03T00:00:00.000Z'),
            editedAt: null,
            deletedAt: null,
          },
        ]),
      );

      const page = await service.listPosts('queer-devs', 'u1');

      expect(page.items[0]!.replies.map((r) => r.id)).toEqual(['r2']);
      expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
        expect.anything(),
        'u1',
        '"r"."author_id"',
      );
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

  describe('listReplies', () => {
    // H2: `listReplies` must gate on `assertViewable` exactly like `listPosts`
    // above — a non-member of a PRIVATE community who still holds a post id
    // (e.g. from an old mention notification, or after being removed from the
    // roster) must not be able to read the thread.
    it("404s a private community's replies for a non-member", async () => {
      communities.findOne.mockResolvedValue({
        ...COMMUNITY,
        accessTier: AccessTier.Private,
      });
      members.findOne.mockResolvedValue(null);
      await expect(
        service.listReplies('queer-devs', 'p1', 'stranger'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('serves replies to a member of a private community', async () => {
      communities.findOne.mockResolvedValue({
        ...COMMUNITY,
        accessTier: AccessTier.Private,
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      // `listReplies` paginates via `.skip().take().getManyAndCount()`, so it
      // needs the page-shaped builder (default empty), not the raw-aggregate
      // one this file's `replies` mock returns for the window/count queries.
      replies.createQueryBuilder.mockReturnValue(qbStub());
      const page = await service.listReplies('queer-devs', 'p1', 'member-1');
      expect(page.items).toEqual([]);
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

    // BE-COM-02: the flat aliases used to run `assertMember` only, so a frozen
    // community (including one auto-frozen over an outing/doxxing report)
    // still took new posts through `POST /community-posts` — exactly what a
    // freeze exists to stop.
    it('rejects a plain member posting into a frozen community', async () => {
      communities.findOne.mockResolvedValue({
        ...COMMUNITY,
        frozenAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      await expect(
        service.createFlatPost('author-1', {
          body: 'hi',
          communitySlug: 'queer-devs',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(posts.save).not.toHaveBeenCalled();
    });

    it('still lets an owner/mod post into a frozen community', async () => {
      communities.findOne.mockResolvedValue({
        ...COMMUNITY,
        frozenAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Mod });
      await expect(
        service.createFlatPost('mod-1', {
          body: 'a moderation note',
          communitySlug: 'queer-devs',
        }),
      ).resolves.toEqual({ id: 'post-id' });
    });

    it('rejects posting into an archived community, even for an owner/mod', async () => {
      communities.findOne.mockResolvedValue({
        ...COMMUNITY,
        archivedAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Mod });
      await expect(
        service.createFlatPost('mod-1', {
          body: 'hi',
          communitySlug: 'queer-devs',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(posts.save).not.toHaveBeenCalled();
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

    // Same `assertFlatWriteAllowed` gate as `createFlatPost` (BE-COM-02) —
    // the flat reply route resolves the post's community and applies the
    // roster/archive/freeze trio the slug-scoped routes always had.
    it('rejects a plain member replying inside a frozen community', async () => {
      communities.findOne.mockResolvedValue({
        ...COMMUNITY,
        frozenAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      await expect(
        service.addFlatReply('p1', 'u1', 'hi'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(replies.save).not.toHaveBeenCalled();
    });
  });

  describe('likeFlatPost (community gate)', () => {
    it('rejects a plain member reacting inside a frozen community', async () => {
      communities.findOne.mockResolvedValue({
        ...COMMUNITY,
        frozenAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      await expect(
        service.likeFlatPost('p1', 'u1', true),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

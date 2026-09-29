import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AccessTier } from '../communities/entities/community.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { TopicPost } from './entities/topic-post.entity';
import { Topic } from './entities/topic.entity';
import { TopicsService } from './topics.service';

describe('TopicsService', () => {
  let service: TopicsService;
  let topics: {
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let topicPosts: {
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { createQueryBuilder: jest.Mock };
  };
  let threadFlagsQueryBuilder: {
    select: jest.Mock;
    where: jest.Mock;
    getMany: jest.Mock;
  };
  let blockFilter: { excludeHidden: jest.Mock };

  const VIEWER_ID = 'viewer-1';

  const healthcare: Topic = {
    id: 'topic-1',
    tag: 'healthcare',
    label: 'healthcare',
    description:
      'Conversations, resources, recommendations, and warnings about navigating health systems as a queer person in Lisbon.',
    totalPosts: 347,
    followerCount: 1200,
    crisisCard: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const trans: Topic = {
    ...healthcare,
    id: 'topic-2',
    tag: 'trans',
    label: 'trans',
    totalPosts: 512,
    followerCount: 2100,
  };

  const post: TopicPost = {
    id: 'post-1',
    topicId: 'topic-1',
    // Seed content has no member behind it; see
    // `1782800720000-AddTopicPostAuthor` on why these are left NULL.
    authorId: null,
    authorName: 'Anika Kovač',
    authorInitials: 'AK',
    authorTone: 'coral',
    contextLabel: 'Trans & Non-Binary Network',
    kind: 'asking',
    category: 'thread',
    title: 'Anyone have recommendations for a queer-friendly GP in Lisbon?',
    body: 'Preferably someone familiar with trans healthcare.',
    reactionCount: 42,
    reactionLabel: 'relate',
    replyCount: 18,
    replyLabel: 'replies',
    tags: ['healthcare', 'trans', 'lisbon'],
    href: '/forum',
    forumThreadId: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
  };

  function makeQueryBuilder(rows: TopicPost[]) {
    return {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(rows),
    };
  }

  beforeEach(async () => {
    topics = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    threadFlagsQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    topicPosts = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder([])),
      manager: {
        createQueryBuilder: jest.fn().mockReturnValue(threadFlagsQueryBuilder),
      },
    };
    blockFilter = { excludeHidden: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TopicsService,
        { provide: getRepositoryToken(Topic), useValue: topics },
        { provide: getRepositoryToken(TopicPost), useValue: topicPosts },
        { provide: BlockFilterService, useValue: blockFilter },
      ],
    }).compile();
    service = module.get(TopicsService);
  });

  describe('list', () => {
    it('orders the directory by most posts first', async () => {
      await service.list();
      expect(topics.find).toHaveBeenCalledWith({
        order: { totalPosts: 'DESC' },
      });
    });

    it('maps rows to TopicResponse[]', async () => {
      topics.find.mockResolvedValue([healthcare]);

      const list = await service.list();

      expect(list).toEqual([
        {
          tag: 'healthcare',
          label: 'healthcare',
          description: healthcare.description,
          totalPosts: 347,
          crisisCard: true,
        },
      ]);
    });

    it('returns an empty array when there are no topics', async () => {
      const list = await service.list();
      expect(list).toEqual([]);
    });
  });

  describe('getBySlug', () => {
    it('throws NotFoundException when the topic does not exist', async () => {
      await expect(service.getBySlug('nope')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('normalizes a leading "#" and casing before looking the topic up', async () => {
      topics.findOne.mockResolvedValue(healthcare);
      await service.getBySlug('#Healthcare');
      expect(topics.findOne).toHaveBeenCalledWith({
        where: { tag: 'healthcare' },
      });
    });

    it('returns the topic meta plus followerCount, postsThisWeek, and relatedTopics', async () => {
      topics.findOne.mockResolvedValue(healthcare);
      topics.find.mockResolvedValue([trans, healthcare]);
      topicPosts.count.mockResolvedValue(5);

      const detail = await service.getBySlug('healthcare');

      expect(detail).toEqual({
        tag: 'healthcare',
        label: 'healthcare',
        description: healthcare.description,
        totalPosts: 347,
        crisisCard: true,
        followerCount: 1200,
        postsThisWeek: 5,
        relatedTopics: [{ tag: 'trans', count: 512 }],
      });
    });

    it('excludes the topic itself from relatedTopics even when it ranks first', async () => {
      topics.findOne.mockResolvedValue(healthcare);
      topics.find.mockResolvedValue([healthcare, trans]);

      const detail = await service.getBySlug('healthcare');

      expect(detail.relatedTopics).toEqual([{ tag: 'trans', count: 512 }]);
    });
  });

  describe('listPosts', () => {
    it('throws NotFoundException when the topic does not exist', async () => {
      await expect(
        service.listPosts('nope', VIEWER_ID, undefined, undefined),
      ).rejects.toThrow(NotFoundException);
    });

    it('scopes the query to the resolved topic id and maps rows to TopicPostResponse[]', async () => {
      topics.findOne.mockResolvedValue(healthcare);
      const qb = makeQueryBuilder([post]);
      topicPosts.createQueryBuilder.mockReturnValue(qb);

      const page = await service.listPosts(
        'healthcare',
        VIEWER_ID,
        undefined,
        undefined,
      );

      expect(qb.where).toHaveBeenCalledWith('tp.topicId = :topicId', {
        topicId: 'topic-1',
      });
      expect(page).toEqual({
        data: [
          {
            id: 'post-1',
            topicId: 'topic-1',
            author: 'Anika Kovač',
            authorInitials: 'AK',
            authorTone: 'coral',
            contextLabel: 'Trans & Non-Binary Network',
            kind: 'asking',
            category: 'thread',
            title: post.title,
            body: post.body,
            reactionCount: 42,
            reactionLabel: 'relate',
            replyCount: 18,
            replyLabel: 'replies',
            tags: ['healthcare', 'trans', 'lisbon'],
            href: '/forum',
            createdAt: post.createdAt.toISOString(),
          },
        ],
        pageInfo: { nextCursor: null, hasMore: false },
      });
    });

    it('applies the block/mute filter in-query against the author column', async () => {
      topics.findOne.mockResolvedValue(healthcare);
      const qb = makeQueryBuilder([post]);
      topicPosts.createQueryBuilder.mockReturnValue(qb);

      await service.listPosts('healthcare', VIEWER_ID, undefined, undefined);

      // Raw, already-quoted snake_case column per `BlockFilterService`'s
      // splicing contract, written as SQL in place of a TypeORM camelCase
      // property path.
      expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
        qb,
        VIEWER_ID,
        '"tp"."author_id"',
      );
    });

    it('listPosts drops a row whose thread sits in a private community', async () => {
      topics.findOne.mockResolvedValue(healthcare);
      const qb = makeQueryBuilder([]);
      topicPosts.createQueryBuilder.mockReturnValue(qb);

      await service.listPosts('healthcare', VIEWER_ID, undefined, undefined);

      // The drop happens in SQL, so the gate itself is what this pins: a
      // linked thread must be live and either forum-wide or in a community
      // whose roster counts the viewer. A private community the viewer is not
      // on fails every arm.
      const gateCall = (
        qb.andWhere.mock.calls as unknown as Array<
          [string, Record<string, unknown>]
        >
      ).find(([sql]) => sql.includes('"tp"."forum_thread_id"'));
      if (!gateCall) throw new Error('expected the linked-thread gate');
      const [gateSql, gateParams] = gateCall;
      expect(gateSql).toContain('"tp"."forum_thread_id" IS NULL');
      expect(gateSql).toContain('"t"."deleted_at" IS NULL');
      expect(gateSql).toContain('t.published_at <= now()');
      expect(gateSql).toContain('"t"."cross_posted" = true');
      expect(gateSql).toContain(
        '"topic_com"."access_tier" = :topicPostPublicTier',
      );
      expect(gateSql).toContain('"topic_com"."parent_id" IS NULL');
      expect(gateSql).toContain('"topic_com"."archived_at" IS NULL');
      expect(gateSql).toContain('"topic_mem"."user_id" = :topicPostViewerId');
      expect(gateParams).toEqual({
        topicPostPublicTier: AccessTier.Public,
        topicPostViewerId: VIEWER_ID,
        topicPostModerationSubjectTypes: ['post', 'reply'],
      });
    });

    it('listPosts drops a row whose opening post was taken down', async () => {
      // `topic_post.body` is a copy of the thread's opening post, so a row
      // whose opening post the author tombstoned, or a moderator hid or
      // removed, must leave the topic page as it leaves the feed.
      topics.findOne.mockResolvedValue(healthcare);
      const qb = makeQueryBuilder([]);
      topicPosts.createQueryBuilder.mockReturnValue(qb);

      await service.listPosts('healthcare', VIEWER_ID, undefined, undefined);

      const gateCall = (
        qb.andWhere.mock.calls as unknown as Array<
          [string, Record<string, unknown>]
        >
      ).find(([sql]) => sql.includes('"tp"."forum_thread_id"'));
      if (!gateCall) throw new Error('expected the linked-thread gate');
      const [gateSql, gateParams] = gateCall;
      // The author's own tombstone on the opening post.
      expect(gateSql).toMatch(
        /NOT EXISTS \(\s*SELECT 1 FROM "forum_post" "topic_deleted_op"\s*WHERE "topic_deleted_op"\."thread_id" = "t"\."id"\s*AND "topic_deleted_op"\."is_op" = true\s*AND "topic_deleted_op"\."deleted_at" IS NOT NULL/,
      );
      // A moderator's takedown of the opening post, hidden or removed.
      expect(gateSql).toContain(
        '"topic_cm"."subject_type" IN (:...topicPostModerationSubjectTypes)',
      );
      expect(gateSql).toContain(
        '"topic_cm"."subject_id" = "topic_op"."id"::text',
      );
      expect(gateSql).toContain('"topic_op"."is_op" = true');
      expect(gateSql).toContain(
        '("topic_cm"."hidden_at" IS NOT NULL OR "topic_cm"."removed_at" IS NOT NULL)',
      );
      expect(gateParams.topicPostModerationSubjectTypes).toEqual([
        'post',
        'reply',
      ]);
    });

    it('listPosts masks the author of an anonymous thread written before the fix', async () => {
      topics.findOne.mockResolvedValue(healthcare);
      const legacyRow: TopicPost = {
        ...post,
        id: 'post-2',
        authorId: 'author-1',
        authorName: 'Rita Sousa',
        authorInitials: 'RS',
        authorTone: 'coral',
        forumThreadId: 'thread-1',
      };
      topicPosts.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([legacyRow, post]),
      );
      threadFlagsQueryBuilder.getMany.mockResolvedValue([
        { id: 'thread-1', isAnonymous: true, isOfficial: false },
      ]);

      const page = await service.listPosts(
        'healthcare',
        VIEWER_ID,
        undefined,
        undefined,
      );

      expect(threadFlagsQueryBuilder.where).toHaveBeenCalledWith(
        'thread.id IN (:...threadIds)',
        { threadIds: ['thread-1'] },
      );
      expect(page.data[0]).toMatchObject({
        author: 'Anonymous member',
        authorInitials: 'A',
        authorTone: 'plum',
      });
      // An editorial row with no thread keeps its stored byline.
      expect(page.data[1]).toMatchObject({
        author: 'Anika Kovač',
        authorInitials: 'AK',
      });
    });

    it('a topic post linked to a thread whose author was erased carries the generic byline', async () => {
      // ENG-494: the thread survives its author's erasure with a NULL
      // `author_id`, and a row linked before the erasure scrub still stores
      // the member's name. The read path must not serve it.
      topics.findOne.mockResolvedValue(healthcare);
      const orphanedRow: TopicPost = {
        ...post,
        id: 'post-3',
        authorId: null,
        authorName: 'Rita Sousa',
        authorInitials: 'RS',
        authorTone: 'coral',
        forumThreadId: 'thread-erased',
      };
      const livingAuthorRow: TopicPost = {
        ...post,
        id: 'post-4',
        authorId: 'author-2',
        authorName: 'Joana Reis',
        authorInitials: 'JR',
        authorTone: 'jade',
        forumThreadId: 'thread-living',
      };
      topicPosts.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([orphanedRow, livingAuthorRow]),
      );
      threadFlagsQueryBuilder.getMany.mockResolvedValue([
        {
          id: 'thread-erased',
          isAnonymous: false,
          isOfficial: false,
          authorId: null,
        },
        {
          id: 'thread-living',
          isAnonymous: false,
          isOfficial: false,
          authorId: 'author-2',
        },
      ]);

      const page = await service.listPosts(
        'healthcare',
        VIEWER_ID,
        undefined,
        undefined,
      );

      expect(threadFlagsQueryBuilder.select).toHaveBeenCalledWith(
        expect.arrayContaining(['thread.authorId']),
      );
      expect(page.data[0]).toMatchObject({
        author: 'Member',
        authorInitials: 'M',
        authorTone: 'default',
      });
      expect(page.data[1]).toMatchObject({
        author: 'Joana Reis',
        authorInitials: 'JR',
        authorTone: 'jade',
      });
    });

    it('keeps the anonymous mask on a thread whose author was erased', async () => {
      topics.findOne.mockResolvedValue(healthcare);
      topicPosts.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([
          { ...post, id: 'post-5', forumThreadId: 'thread-anonymous' },
        ]),
      );
      threadFlagsQueryBuilder.getMany.mockResolvedValue([
        {
          id: 'thread-anonymous',
          isAnonymous: true,
          isOfficial: false,
          authorId: null,
        },
      ]);

      const page = await service.listPosts(
        'healthcare',
        VIEWER_ID,
        undefined,
        undefined,
      );

      expect(page.data[0]).toMatchObject({ author: 'Anonymous member' });
    });

    it('returns an empty page when the topic has no posts', async () => {
      topics.findOne.mockResolvedValue(healthcare);

      const page = await service.listPosts(
        'healthcare',
        VIEWER_ID,
        undefined,
        undefined,
      );

      expect(page).toEqual({
        data: [],
        pageInfo: { nextCursor: null, hasMore: false },
      });
    });
  });
});

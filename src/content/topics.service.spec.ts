import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
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
  };

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
    topicPosts = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder([])),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TopicsService,
        { provide: getRepositoryToken(Topic), useValue: topics },
        { provide: getRepositoryToken(TopicPost), useValue: topicPosts },
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
      await expect(service.listPosts('nope', undefined, undefined)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('scopes the query to the resolved topic id and maps rows to TopicPostResponse[]', async () => {
      topics.findOne.mockResolvedValue(healthcare);
      const qb = makeQueryBuilder([post]);
      topicPosts.createQueryBuilder.mockReturnValue(qb);

      const page = await service.listPosts('healthcare', undefined, undefined);

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

    it('returns an empty page when the topic has no posts', async () => {
      topics.findOne.mockResolvedValue(healthcare);

      const page = await service.listPosts('healthcare', undefined, undefined);

      expect(page).toEqual({
        data: [],
        pageInfo: { nextCursor: null, hasMore: false },
      });
    });
  });
});

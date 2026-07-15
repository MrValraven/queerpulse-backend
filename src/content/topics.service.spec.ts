import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Topic } from './entities/topic.entity';
import { TopicsService } from './topics.service';

describe('TopicsService', () => {
  let service: TopicsService;
  let topics: {
    find: jest.Mock;
  };

  const healthcare: Topic = {
    id: 'topic-1',
    tag: 'healthcare',
    label: 'healthcare',
    description:
      'Conversations, resources, recommendations, and warnings about navigating health systems as a queer person in Lisbon.',
    totalPosts: 347,
    crisisCard: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(async () => {
    topics = {
      find: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TopicsService,
        { provide: getRepositoryToken(Topic), useValue: topics },
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
          description:
            'Conversations, resources, recommendations, and warnings about navigating health systems as a queer person in Lisbon.',
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
});

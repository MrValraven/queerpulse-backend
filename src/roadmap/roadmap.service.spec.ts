import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { RoadmapIdea } from './entities/roadmap-idea.entity';
import { RoadmapItem } from './entities/roadmap-item.entity';
import { RoadmapSettings } from './entities/roadmap-settings.entity';
import { RoadmapVote } from './entities/roadmap-vote.entity';
import { RoadmapService } from './roadmap.service';

// A chainable query-builder stub whose terminal method resolves to an empty
// max by default (mirrors `roadmap-admin.service.spec.ts`'s `qbStub`).
const queryBuilderStub = () => {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of ['select', 'addSelect', 'where', 'andWhere']) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawOne = jest.fn().mockResolvedValue({ max: null });
  queryBuilder.getRawMany = jest.fn().mockResolvedValue([]);
  return queryBuilder;
};

describe('RoadmapService', () => {
  let service: RoadmapService;
  let ideas: {
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let adminQueueNotifications: { announce: jest.Mock };

  beforeEach(async () => {
    ideas = {
      // `create` returns the plain, unsaved entity with no `id` yet, matching
      // TypeORM's real behavior. An assertion below proves `announce` reads
      // the SAVED row's id rather than this one, so this mock deliberately
      // withholds an id here for that proof to mean anything.
      create: jest.fn((value: Partial<RoadmapIdea>) => ({ ...value })),
      save: jest.fn((value: Partial<RoadmapIdea>) =>
        Promise.resolve({ id: 'idea-1', ...value }),
      ),
      createQueryBuilder: jest.fn(() => queryBuilderStub()),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoadmapService,
        { provide: getRepositoryToken(RoadmapItem), useValue: {} },
        { provide: getRepositoryToken(RoadmapIdea), useValue: ideas },
        { provide: getRepositoryToken(RoadmapVote), useValue: {} },
        { provide: getRepositoryToken(RoadmapSettings), useValue: {} },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();

    service = module.get(RoadmapService);
  });

  describe('submitIdea', () => {
    it('tells the roadmap queue that an idea landed, with the saved id', async () => {
      const result = await service.submitIdea('member-1', {
        text: 'Add a dark mode toggle to every settings screen',
      });

      expect(result).toEqual({ status: 'pending' });
      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.RoadmapIdeas,
        'idea-1',
      );
    });

    it('tells nobody when the row never gets saved', async () => {
      ideas.save.mockRejectedValueOnce(new Error('write failed'));

      await expect(
        service.submitIdea('member-1', {
          text: 'Add a dark mode toggle to every settings screen',
        }),
      ).rejects.toThrow('write failed');

      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { RoadmapIdea } from './entities/roadmap-idea.entity';
import { RoadmapItem } from './entities/roadmap-item.entity';
import { RoadmapVote, RoadmapVoteTarget } from './entities/roadmap-vote.entity';
import { RoadmapService } from './roadmap.service';

// A chainable query-builder stub whose terminal method resolves to an empty
// max by default (mirrors `roadmap-admin.service.spec.ts`'s `qbStub`).
const queryBuilderStub = () => {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
  ]) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawOne = jest.fn().mockResolvedValue({ max: null });
  queryBuilder.getRawMany = jest.fn().mockResolvedValue([]);
  return queryBuilder as Record<string, jest.Mock> & { getRawMany: jest.Mock };
};

describe('RoadmapService', () => {
  let service: RoadmapService;
  let ideas: {
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let items: { exists: jest.Mock; findOne: jest.Mock };
  let votes: { delete: jest.Mock; createQueryBuilder: jest.Mock };
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
    items = {
      exists: jest.fn().mockResolvedValue(true),
      findOne: jest.fn().mockResolvedValue({ id: 'item-1', votes: 10 }),
    };
    votes = {
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => queryBuilderStub()),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoadmapService,
        { provide: getRepositoryToken(RoadmapItem), useValue: items },
        { provide: getRepositoryToken(RoadmapIdea), useValue: ideas },
        { provide: getRepositoryToken(RoadmapVote), useValue: votes },
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

  describe('removeVote', () => {
    const targetId = '3f0a6c1e-6a52-4a52-9f0e-2d3a1d7f5b10';

    it('deletes only the caller row and returns the recomputed total with voted false', async () => {
      const queryBuilder = queryBuilderStub();
      queryBuilder.getRawMany.mockResolvedValue([{ targetId, count: '3' }]);
      votes.createQueryBuilder.mockReturnValue(queryBuilder);

      const result = await service.removeVote('member-1', {
        targetType: RoadmapVoteTarget.Item,
        targetId,
      });

      expect(votes.delete).toHaveBeenCalledWith({
        memberId: 'member-1',
        targetType: RoadmapVoteTarget.Item,
        targetId,
      });
      expect(result).toEqual({ targetId, votes: 13, voted: false });
    });

    it('still answers voted false when the caller never voted', async () => {
      votes.delete.mockResolvedValueOnce({ affected: 0 });

      const result = await service.removeVote('member-1', {
        targetType: RoadmapVoteTarget.Item,
        targetId,
      });

      expect(result).toEqual({ targetId, votes: 10, voted: false });
    });

    it('names the missing roadmap item when the id is unknown', async () => {
      items.exists.mockResolvedValueOnce(false);

      await expect(
        service.removeVote('member-1', {
          targetType: RoadmapVoteTarget.Item,
          targetId,
        }),
      ).rejects.toThrow('Roadmap item not found');

      expect(votes.delete).not.toHaveBeenCalled();
    });
  });
});

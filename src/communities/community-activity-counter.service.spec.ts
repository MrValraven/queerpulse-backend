import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Community } from './entities/community.entity';
import { CommunityActivityCounterService } from './community-activity-counter.service';

describe('CommunityActivityCounterService', () => {
  let service: CommunityActivityCounterService;
  let communities: { query: jest.Mock };

  beforeEach(async () => {
    communities = {
      // `[rows, affectedCount]`, same shape a raw UPDATE query resolves to.
      query: jest.fn().mockResolvedValue([[], 0]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityActivityCounterService,
        { provide: getRepositoryToken(Community), useValue: communities },
      ],
    }).compile();
    service = module.get(CommunityActivityCounterService);
  });

  describe('recompute', () => {
    it('recomputes a space the same as a top-level community, carrying no parent_id filter', async () => {
      // Coordinator ruling: a space's own card still reads and displays
      // `activeThisWeek`, so this job must not leave it frozen at a stale
      // value. Discover sort/filter (the one surface this column exists
      // for) already keeps spaces out through `topLevelOnly`, so this job
      // is deliberately unscoped.
      await service.recompute();

      const [sql] = communities.query.mock.calls[0] as [string, unknown[]];
      expect(sql).not.toContain('parent_id');
      expect(sql).toContain('WHERE target.id = activity.community_id');
    });
  });
});

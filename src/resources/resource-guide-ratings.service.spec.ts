import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ResourceGuideRating } from './entities/resource-guide-rating.entity';
import { ResourceGuideRatingsService } from './resource-guide-ratings.service';

/**
 * Rewritten for CNT-18: the service no longer loads every vote row for a
 * guide and counts them in JS. It reads only the caller's own row
 * (`findOne`), writes through `upsert` (INSERT … ON CONFLICT DO UPDATE, so a
 * double-click converges instead of raising a unique violation), and tallies
 * with a `COUNT(*) FILTER (…)` aggregate. The mocks below follow that shape.
 */
describe('ResourceGuideRatingsService', () => {
  let service: ResourceGuideRatingsService;
  let tally: { helpfulCount: string; notHelpfulCount: string };
  let queryBuilder: {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    getRawOne: jest.Mock;
  };
  let ratings: {
    findOne: jest.Mock;
    upsert: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  beforeEach(async () => {
    tally = { helpfulCount: '0', notHelpfulCount: '0' };
    queryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(() => Promise.resolve(tally)),
    };
    ratings = {
      findOne: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ identifiers: [] }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => queryBuilder),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResourceGuideRatingsService,
        {
          provide: getRepositoryToken(ResourceGuideRating),
          useValue: ratings,
        },
      ],
    }).compile();
    service = module.get(ResourceGuideRatingsService);
  });

  it('rejects a malformed content key', async () => {
    await expect(
      service.rate('../../etc/passwd', 'member-1', 'helpful'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('upserts the vote on first rate rather than blind-inserting', async () => {
    ratings.findOne.mockResolvedValue(null);
    tally = { helpfulCount: '1', notHelpfulCount: '0' };

    const result = await service.rate(
      'legal.workplace.dismissal',
      'member-1',
      'helpful',
    );

    expect(ratings.upsert).toHaveBeenCalledWith(
      {
        contentKey: 'legal.workplace.dismissal',
        memberId: 'member-1',
        value: 'helpful',
      },
      expect.objectContaining({
        conflictPaths: ['contentKey', 'memberId'],
      }),
    );
    expect(result).toEqual({
      contentKey: 'legal.workplace.dismissal',
      helpfulCount: 1,
      notHelpfulCount: 0,
      myVote: 'helpful',
    });
  });

  it('clears the vote when the same value is cast again (toggle-clear)', async () => {
    ratings.findOne.mockResolvedValue({
      id: 'r1',
      contentKey: 'legal.workplace.dismissal',
      memberId: 'member-1',
      value: 'helpful',
    });

    const result = await service.rate(
      'legal.workplace.dismissal',
      'member-1',
      'helpful',
    );

    // Deleted by its natural key, so a concurrent re-vote cannot leave a
    // stale surrogate id pointing at the wrong row.
    expect(ratings.delete).toHaveBeenCalledWith({
      contentKey: 'legal.workplace.dismissal',
      memberId: 'member-1',
    });
    expect(ratings.upsert).not.toHaveBeenCalled();
    expect(result.myVote).toBeNull();
  });

  it('changes the vote when a different value is cast (toggle-change)', async () => {
    ratings.findOne.mockResolvedValue({
      id: 'r1',
      contentKey: 'legal.workplace.dismissal',
      memberId: 'member-1',
      value: 'helpful',
    });
    tally = { helpfulCount: '0', notHelpfulCount: '1' };

    const result = await service.rate(
      'legal.workplace.dismissal',
      'member-1',
      'not_helpful',
    );

    expect(ratings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'not_helpful' }),
      expect.anything(),
    );
    expect(result).toEqual({
      contentKey: 'legal.workplace.dismissal',
      helpfulCount: 0,
      notHelpfulCount: 1,
      myVote: 'not_helpful',
    });
  });

  it('getForContentKey aggregates in SQL and reads only the caller row', async () => {
    tally = { helpfulCount: '2', notHelpfulCount: '1' };
    ratings.findOne.mockResolvedValue({
      id: 'r2',
      contentKey: 'x',
      memberId: 'member-2',
      value: 'not_helpful',
    });

    const result = await service.getForContentKey('x', 'member-2');

    expect(ratings.findOne).toHaveBeenCalledWith({
      where: { contentKey: 'x', memberId: 'member-2' },
    });
    expect(queryBuilder.where).toHaveBeenCalledWith(
      'rating.contentKey = :contentKey',
      { contentKey: 'x' },
    );
    expect(result).toEqual({
      contentKey: 'x',
      helpfulCount: 2,
      notHelpfulCount: 1,
      myVote: 'not_helpful',
    });
  });

  it('reports zero counts when the guide has no votes at all', async () => {
    queryBuilder.getRawOne.mockResolvedValue(undefined);
    ratings.findOne.mockResolvedValue(null);

    const result = await service.getForContentKey('x', 'member-1');

    expect(result).toEqual({
      contentKey: 'x',
      helpfulCount: 0,
      notHelpfulCount: 0,
      myVote: null,
    });
  });
});

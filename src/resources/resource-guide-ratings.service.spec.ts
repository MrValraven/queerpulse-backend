import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ResourceGuideRating } from './entities/resource-guide-rating.entity';
import { ResourceGuideRatingsService } from './resource-guide-ratings.service';

describe('ResourceGuideRatingsService', () => {
  let service: ResourceGuideRatingsService;
  let ratings: {
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    ratings = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(),
      create: jest.fn((row: unknown) => row),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
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

  it('creates a vote on first rate', async () => {
    ratings.find.mockResolvedValue([]);
    ratings.save.mockImplementation((row: unknown) => row);

    const result = await service.rate(
      'legal.workplace.dismissal',
      'member-1',
      'helpful',
    );

    expect(ratings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        contentKey: 'legal.workplace.dismissal',
        memberId: 'member-1',
        value: 'helpful',
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
    const existing = {
      id: 'r1',
      contentKey: 'legal.workplace.dismissal',
      memberId: 'member-1',
      value: 'helpful' as const,
    };
    ratings.find.mockResolvedValue([existing]);

    const result = await service.rate(
      'legal.workplace.dismissal',
      'member-1',
      'helpful',
    );

    expect(ratings.delete).toHaveBeenCalledWith({ id: 'r1' });
    expect(result).toEqual({
      contentKey: 'legal.workplace.dismissal',
      helpfulCount: 0,
      notHelpfulCount: 0,
      myVote: null,
    });
  });

  it('changes the vote when a different value is cast (toggle-change)', async () => {
    const existing = {
      id: 'r1',
      contentKey: 'legal.workplace.dismissal',
      memberId: 'member-1',
      value: 'helpful' as const,
    };
    ratings.find.mockResolvedValue([existing]);
    ratings.save.mockImplementation((row: unknown) => row);

    const result = await service.rate(
      'legal.workplace.dismissal',
      'member-1',
      'not_helpful',
    );

    expect(ratings.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1', value: 'not_helpful' }),
    );
    expect(result).toEqual({
      contentKey: 'legal.workplace.dismissal',
      helpfulCount: 0,
      notHelpfulCount: 1,
      myVote: 'not_helpful',
    });
  });

  it('getForContentKey returns aggregate counts and the caller vote', async () => {
    ratings.find.mockResolvedValue([
      { id: 'r1', contentKey: 'x', memberId: 'member-1', value: 'helpful' },
      { id: 'r2', contentKey: 'x', memberId: 'member-2', value: 'not_helpful' },
      { id: 'r3', contentKey: 'x', memberId: 'member-3', value: 'helpful' },
    ]);

    const result = await service.getForContentKey('x', 'member-2');

    expect(result).toEqual({
      contentKey: 'x',
      helpfulCount: 2,
      notHelpfulCount: 1,
      myVote: 'not_helpful',
    });
  });
});

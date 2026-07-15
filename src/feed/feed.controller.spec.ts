import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { FeedController } from './feed.controller';
import { FeedService } from './feed.service';

const user: CurrentUserData = {
  userId: 'user-1',
  email: 'a@example.com',
  status: 'active',
  role: 'member',
};

describe('FeedController', () => {
  let controller: FeedController;
  let feedService: { getFeed: jest.Mock };

  beforeEach(async () => {
    feedService = {
      getFeed: jest.fn().mockResolvedValue({
        data: [],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FeedController],
      providers: [{ provide: FeedService, useValue: feedService }],
    }).compile();
    controller = module.get(FeedController);
  });

  it('delegates to FeedService with the caller id, tab, and cursor', async () => {
    await controller.getFeed(user, { tab: 'communities', cursor: 'c1' });
    expect(feedService.getFeed).toHaveBeenCalledWith(
      'user-1',
      'communities',
      'c1',
    );
  });

  it('passes tab/cursor through as undefined when omitted', async () => {
    await controller.getFeed(user, {});
    expect(feedService.getFeed).toHaveBeenCalledWith(
      'user-1',
      undefined,
      undefined,
    );
  });

  it('returns whatever the service resolves', async () => {
    const page = {
      data: [{ id: 'x' }],
      pageInfo: { nextCursor: null, hasMore: false },
    };
    feedService.getFeed.mockResolvedValue(page);
    await expect(controller.getFeed(user, {})).resolves.toBe(page);
  });
});

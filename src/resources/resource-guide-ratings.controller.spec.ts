import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ResourceGuideRatingsController } from './resource-guide-ratings.controller';
import { ResourceGuideRatingsService } from './resource-guide-ratings.service';

const user: CurrentUserData = {
  userId: 'user-1',
  email: 'a@example.com',
  status: 'active',
  role: 'member',
};

describe('ResourceGuideRatingsController', () => {
  let controller: ResourceGuideRatingsController;
  let service: { rate: jest.Mock; getForContentKey: jest.Mock };

  beforeEach(async () => {
    service = {
      rate: jest.fn().mockResolvedValue({}),
      getForContentKey: jest.fn().mockResolvedValue({}),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ResourceGuideRatingsController],
      providers: [{ provide: ResourceGuideRatingsService, useValue: service }],
    }).compile();
    controller = module.get(ResourceGuideRatingsController);
  });

  it('GET delegates to getForContentKey with the content key and caller id', async () => {
    await controller.get('legal.workplace.dismissal', user);
    expect(service.getForContentKey).toHaveBeenCalledWith(
      'legal.workplace.dismissal',
      'user-1',
    );
  });

  it('POST delegates to rate with the content key, caller id, and value', async () => {
    await controller.rate('legal.workplace.dismissal', user, {
      value: 'helpful',
    });
    expect(service.rate).toHaveBeenCalledWith(
      'legal.workplace.dismissal',
      'user-1',
      'helpful',
    );
  });
});

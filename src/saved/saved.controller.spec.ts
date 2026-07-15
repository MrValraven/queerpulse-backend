import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { SavedItemBodyDto } from './dto/saved-item-body.dto';
import { SavedKind } from './entities/saved-item.entity';
import { SavedController } from './saved.controller';
import { SavedService } from './saved.service';

describe('SavedController', () => {
  let controller: SavedController;
  let service: {
    list: jest.Mock;
    put: jest.Mock;
    remove: jest.Mock;
  };

  const user: CurrentUserData = {
    userId: 'u1',
    email: 'u1@example.com',
    status: 'active',
    role: 'member',
  };

  beforeEach(async () => {
    service = {
      list: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
      }),
      put: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SavedController],
      providers: [{ provide: SavedService, useValue: service }],
    }).compile();

    controller = module.get(SavedController);
  });

  it('list delegates to the service with the caller id + query', async () => {
    await controller.list(user, { kind: SavedKind.Post });
    expect(service.list).toHaveBeenCalledWith('u1', { kind: SavedKind.Post });
  });

  it('put delegates to the service with the caller id, raw id param, and body', async () => {
    const body: SavedItemBodyDto = {
      kind: SavedKind.Post,
      title: 'A community post',
    };
    await controller.put(user, 'post:123', body);
    expect(service.put).toHaveBeenCalledWith('u1', 'post:123', body);
  });

  it('remove delegates to the service with the caller id + raw id param', async () => {
    await controller.remove(user, 'event:pride-picnic');
    expect(service.remove).toHaveBeenCalledWith('u1', 'event:pride-picnic');
  });
});

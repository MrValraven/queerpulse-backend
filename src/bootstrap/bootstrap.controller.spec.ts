import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { BootstrapController } from './bootstrap.controller';
import { BootstrapService } from './bootstrap.service';

describe('BootstrapController', () => {
  let controller: BootstrapController;
  let service: { getForUser: jest.Mock };

  const user: CurrentUserData = {
    userId: 'u1',
    email: 'u1@example.com',
    status: 'active',
    role: 'member',
  };

  beforeEach(async () => {
    service = { getForUser: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BootstrapController],
      providers: [{ provide: BootstrapService, useValue: service }],
    }).compile();

    controller = module.get(BootstrapController);
  });

  it('delegates to the service with the caller id', async () => {
    await controller.get(user);
    expect(service.getForUser).toHaveBeenCalledWith('u1');
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { GenesisController } from './genesis.controller';
import { GenesisService } from './genesis.service';

describe('GenesisController', () => {
  let controller: GenesisController;
  let service: { mintGenesisInvite: jest.Mock; claimAdmin: jest.Mock };

  const founder: CurrentUserData = {
    userId: 'user-1',
    email: 'akatiago@gmail.com',
    status: 'active',
    role: 'member',
  };

  beforeEach(async () => {
    service = {
      mintGenesisInvite: jest.fn().mockResolvedValue({ code: 'ABCD2345' }),
      claimAdmin: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GenesisController],
      providers: [{ provide: GenesisService, useValue: service }],
    }).compile();

    controller = module.get(GenesisController);
  });

  it('returns the minted code', async () => {
    await expect(controller.invite()).resolves.toEqual({ code: 'ABCD2345' });
    expect(service.mintGenesisInvite).toHaveBeenCalledTimes(1);
  });

  it('claims admin for the calling user', async () => {
    await controller.claim(founder);
    expect(service.claimAdmin).toHaveBeenCalledWith(
      'user-1',
      'akatiago@gmail.com',
    );
  });
});

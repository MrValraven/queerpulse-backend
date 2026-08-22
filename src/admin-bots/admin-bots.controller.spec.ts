import { AdminBotsController } from './admin-bots.controller';
import { AdminBotsService } from './admin-bots.service';

describe('AdminBotsController', () => {
  let controller: AdminBotsController;
  let service: jest.Mocked<
    Pick<AdminBotsService, 'listBots' | 'updateBotProfile'>
  >;

  beforeEach(() => {
    service = {
      listBots: jest.fn().mockResolvedValue([]),
      updateBotProfile: jest.fn().mockResolvedValue({ ok: true }),
    };
    controller = new AdminBotsController(
      service as unknown as AdminBotsService,
    );
  });

  it('lists system accounts', async () => {
    await controller.listBots();
    expect(service.listBots).toHaveBeenCalled();
  });

  it('forwards a profile update to the service with the acting admin id and target userId', async () => {
    const dto = { bio: 'Hi' } as never;
    const actingAdmin = { userId: 'admin-1' } as never;
    await controller.updateBotProfile(actingAdmin, 'bot-1', dto);
    expect(service.updateBotProfile).toHaveBeenCalledWith(
      'admin-1',
      'bot-1',
      dto,
    );
  });
});

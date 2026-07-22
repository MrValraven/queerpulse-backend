import { AdminBotsController } from './admin-bots.controller';
import { AdminBotsService } from './admin-bots.service';

describe('AdminBotsController', () => {
  let controller: AdminBotsController;
  let service: jest.Mocked<Pick<AdminBotsService, 'listBots' | 'updateBotProfile'>>;

  beforeEach(() => {
    service = {
      listBots: jest.fn().mockResolvedValue([]),
      updateBotProfile: jest.fn().mockResolvedValue({ ok: true }),
    } as unknown as jest.Mocked<
      Pick<AdminBotsService, 'listBots' | 'updateBotProfile'>
    >;
    controller = new AdminBotsController(service as unknown as AdminBotsService);
  });

  it('lists system accounts', async () => {
    await controller.listBots();
    expect(service.listBots).toHaveBeenCalled();
  });

  it('forwards a profile update to the service by userId', async () => {
    const dto = { bio: 'Hi' } as never;
    await controller.updateBotProfile('bot-1', dto);
    expect(service.updateBotProfile).toHaveBeenCalledWith('bot-1', dto);
  });
});

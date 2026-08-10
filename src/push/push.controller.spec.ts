import { PushController } from './push.controller';
import { PushService } from './push.service';

function makeService() {
  return {
    saveSubscription: jest.fn().mockResolvedValue(undefined),
    removeSubscription: jest.fn().mockResolvedValue(undefined),
    sendToUser: jest.fn().mockResolvedValue(undefined),
  };
}

describe('PushController', () => {
  it('sends a test push to the caller and returns ok', async () => {
    const service = makeService();
    const controller = new PushController(service as unknown as PushService);

    const result = await controller.test({ userId: 'user-1' } as never);

    expect(service.sendToUser).toHaveBeenCalledTimes(1);
    expect(service.sendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        title: 'Test notification',
        body: 'This is a test — your notifications are working.',
        tag: 'push-test',
        data: { url: '/account/settings' },
      }),
    );
    expect(result).toEqual({ ok: true });
  });
});

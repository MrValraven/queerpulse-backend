import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PushService } from './push.service';

const sendNotification = jest.fn();
const setVapidDetails = jest.fn();
jest.mock('web-push', () => ({
  __esModule: true,
  default: {
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

function makeRepo(rows: unknown[] = []) {
  return {
    find: jest.fn().mockResolvedValue(rows),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
  };
}

const config = {
  get: (key: string) =>
    ({
      'push.vapidPublicKey': 'pub',
      'push.vapidPrivateKey': 'priv',
      'push.vapidSubject': 'mailto:a@b.c',
    })[key],
} as unknown as ConfigService;

const payload = {
  title: 'Alex',
  body: 'hey',
  tag: 'conv-1',
  data: { conversationId: 'conv-1', url: '/messages?c=conv-1' },
};

beforeEach(() => {
  sendNotification.mockReset();
  setVapidDetails.mockReset();
});

it('sends a notification to each of the user’s subscriptions', async () => {
  const repo = makeRepo([
    { id: 's1', endpoint: 'e1', p256dh: 'k1', auth: 'a1' },
    { id: 's2', endpoint: 'e2', p256dh: 'k2', auth: 'a2' },
  ]);
  const service = new PushService(repo as never, config);
  service.onModuleInit();
  sendNotification.mockResolvedValue(undefined);

  await service.sendToUser('user-1', payload);

  expect(sendNotification).toHaveBeenCalledTimes(2);
  expect(repo.update).toHaveBeenCalledTimes(2); // last_used_at bumped
});

it('prunes a subscription when the push service returns 410 Gone', async () => {
  const repo = makeRepo([{ id: 's1', endpoint: 'e1', p256dh: 'k1', auth: 'a1' }]);
  const service = new PushService(repo as never, config);
  service.onModuleInit();
  sendNotification.mockRejectedValue({ statusCode: 410 });

  await service.sendToUser('user-1', payload);

  expect(repo.delete).toHaveBeenCalledWith('s1');
});

describe('saveSubscription', () => {
  const input = { endpoint: 'e1', keys: { p256dh: 'k1', auth: 'a1' } };

  it('upserts by endpoint without warning when the owner is unchanged', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({ userId: 'user-1' });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = new PushService(repo as never, config);

    await service.saveSubscription('user-1', input);

    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', endpoint: 'e1' }),
      ['endpoint'],
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('logs a warning when an endpoint is reassigned across accounts', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({ userId: 'victim' });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = new PushService(repo as never, config);

    await service.saveSubscription('attacker', input);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('reassigned from user victim to attacker'),
    );
    // The transfer still happens — shared-device account switches must keep working.
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'attacker', endpoint: 'e1' }),
      ['endpoint'],
    );
    warn.mockRestore();
  });
});

it('does nothing when VAPID keys are not configured', async () => {
  const repo = makeRepo([{ id: 's1', endpoint: 'e1', p256dh: 'k1', auth: 'a1' }]);
  const bareConfig = { get: () => undefined } as unknown as ConfigService;
  const service = new PushService(repo as never, bareConfig);
  service.onModuleInit();

  await service.sendToUser('user-1', payload);

  expect(sendNotification).not.toHaveBeenCalled();
});

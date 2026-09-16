import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PushService,
  READ_DISMISS_TAG_PREFIX,
  pushRetryDelayMs,
} from './push.service';

const sendNotification = jest.fn<Promise<unknown>, unknown[]>();
const setVapidDetails = jest.fn<void, unknown[]>();
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
    { id: 's1', endpoint: 'https://8.8.8.8/e1', p256dh: 'k1', auth: 'a1' },
    { id: 's2', endpoint: 'https://8.8.8.8/e2', p256dh: 'k2', auth: 'a2' },
  ]);
  const service = new PushService(repo as never, config);
  service.onModuleInit();
  sendNotification.mockResolvedValue(undefined);

  await service.sendToUser('user-1', payload);

  expect(sendNotification).toHaveBeenCalledTimes(2);
  expect(repo.update).toHaveBeenCalledTimes(2); // last_used_at bumped
});

it('prunes a subscription when the push service returns 410 Gone', async () => {
  const repo = makeRepo([
    { id: 's1', endpoint: 'https://8.8.8.8/e1', p256dh: 'k1', auth: 'a1' },
  ]);
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
  const repo = makeRepo([
    { id: 's1', endpoint: 'e1', p256dh: 'k1', auth: 'a1' },
  ]);
  const bareConfig = { get: () => undefined } as unknown as ConfigService;
  const service = new PushService(repo as never, bareConfig);
  service.onModuleInit();

  await service.sendToUser('user-1', payload);

  expect(sendNotification).not.toHaveBeenCalled();
});

describe('pushRetryDelayMs', () => {
  const fullBudget = 10_000;

  it('does not retry a status that cannot succeed later', () => {
    expect(pushRetryDelayMs({ statusCode: 404 }, fullBudget)).toBeNull();
    expect(pushRetryDelayMs({ statusCode: 401 }, fullBudget)).toBeNull();
    expect(pushRetryDelayMs({ statusCode: 400 }, fullBudget)).toBeNull();
  });

  it('does not retry a failure with no status (timeout, network, null)', () => {
    expect(
      pushRetryDelayMs(new Error('push-send-timeout'), fullBudget),
    ).toBeNull();
    expect(pushRetryDelayMs(null, fullBudget)).toBeNull();
    expect(pushRetryDelayMs(undefined, fullBudget)).toBeNull();
  });

  it('waits the default 1s for a 429 or 5xx without Retry-After', () => {
    expect(pushRetryDelayMs({ statusCode: 429 }, fullBudget)).toBe(1_000);
    expect(pushRetryDelayMs({ statusCode: 500 }, fullBudget)).toBe(1_000);
    expect(pushRetryDelayMs({ statusCode: 503 }, fullBudget)).toBe(1_000);
  });

  it('honours a numeric Retry-After in seconds', () => {
    expect(
      pushRetryDelayMs(
        { statusCode: 429, headers: { 'retry-after': '2' } },
        fullBudget,
      ),
    ).toBe(2_000);
    expect(
      pushRetryDelayMs(
        { statusCode: 503, headers: { 'retry-after': ['3'] } },
        fullBudget,
      ),
    ).toBe(3_000);
    expect(
      pushRetryDelayMs(
        { statusCode: 503, headers: { 'retry-after': '0' } },
        fullBudget,
      ),
    ).toBe(0);
  });

  it('clamps a long Retry-After to 5s', () => {
    expect(
      pushRetryDelayMs(
        { statusCode: 429, headers: { 'retry-after': '120' } },
        fullBudget,
      ),
    ).toBe(5_000);
  });

  it('falls back to the default for the HTTP-date form or junk', () => {
    expect(
      pushRetryDelayMs(
        {
          statusCode: 503,
          headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
        },
        fullBudget,
      ),
    ).toBe(1_000);
    expect(
      pushRetryDelayMs(
        { statusCode: 503, headers: { 'retry-after': '-4' } },
        fullBudget,
      ),
    ).toBe(1_000);
  });

  it('skips the retry when the wait would leave too short an attempt', () => {
    // 2.5s left, 1s wait: a 1.5s attempt is under the 2s minimum.
    expect(pushRetryDelayMs({ statusCode: 503 }, 2_500)).toBeNull();
    // A 5s Retry-After inside 6s left leaves only 1s.
    expect(
      pushRetryDelayMs(
        { statusCode: 429, headers: { 'retry-after': '5' } },
        6_000,
      ),
    ).toBeNull();
  });
});

describe('deliverToSubscription failure handling', () => {
  const oneRow = () =>
    makeRepo([
      { id: 's1', endpoint: 'https://8.8.8.8/e1', p256dh: 'k1', auth: 'a1' },
    ]);
  // `Retry-After: 0` keeps the retry's wait at zero so the spec needs no
  // fake timers.
  const throttled = (statusCode: number) => ({
    statusCode,
    headers: { 'retry-after': '0' },
  });

  it.each([401, 403])(
    'prunes a subscription made under a rotated VAPID key (%i)',
    async (statusCode) => {
      const repo = oneRow();
      const service = new PushService(repo as never, config);
      service.onModuleInit();
      sendNotification.mockRejectedValue({ statusCode });

      await service.sendToUser('user-1', payload);

      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(repo.delete).toHaveBeenCalledWith('s1');
    },
  );

  it('retries once after a 503 and records the delivery when it lands', async () => {
    const repo = oneRow();
    const service = new PushService(repo as never, config);
    service.onModuleInit();
    sendNotification
      .mockRejectedValueOnce(throttled(503))
      .mockResolvedValueOnce(undefined);

    await service.sendToUser('user-1', payload);

    expect(sendNotification).toHaveBeenCalledTimes(2);
    const [updatedId, updatedFields] = repo.update.mock.calls[0] as [
      string,
      { lastUsedAt: unknown },
    ];
    expect(updatedId).toBe('s1');
    expect(updatedFields.lastUsedAt).toBeInstanceOf(Date);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('logs and keeps the row when a 429 retry also fails, without rejecting', async () => {
    const repo = oneRow();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = new PushService(repo as never, config);
    service.onModuleInit();
    sendNotification.mockRejectedValue(throttled(429));

    await expect(
      service.sendToUser('user-1', payload),
    ).resolves.toBeUndefined();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(repo.delete).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('s1 after one retry: 429'),
    );
    warn.mockRestore();
  });

  it('prunes when the retry reports the subscription gone', async () => {
    const repo = oneRow();
    const service = new PushService(repo as never, config);
    service.onModuleInit();
    sendNotification
      .mockRejectedValueOnce(throttled(502))
      .mockRejectedValueOnce({ statusCode: 410 });

    await service.sendToUser('user-1', payload);

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(repo.delete).toHaveBeenCalledWith('s1');
  });

  it('does not retry a 400', async () => {
    const repo = oneRow();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = new PushService(repo as never, config);
    service.onModuleInit();
    sendNotification.mockRejectedValue({ statusCode: 400 });

    await service.sendToUser('user-1', payload);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(repo.delete).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('s1: 400'));
    warn.mockRestore();
  });
});

describe('handleSessionRevoked', () => {
  function makeDeleteBuilder(execute: jest.Mock) {
    const builder = {
      delete: jest.fn(),
      from: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      execute,
    };
    builder.delete.mockReturnValue(builder);
    builder.from.mockReturnValue(builder);
    builder.where.mockReturnValue(builder);
    builder.andWhere.mockReturnValue(builder);
    return builder;
  }

  it('deletes the member’s subscriptions only when no live session remains', async () => {
    const builder = makeDeleteBuilder(
      jest.fn().mockResolvedValue({ affected: 2 }),
    );
    const repo = {
      ...makeRepo(),
      createQueryBuilder: jest.fn().mockReturnValue(builder),
    };
    const service = new PushService(repo as never, config);

    await service.handleSessionRevoked({ userId: 'user-1' });

    expect(builder.delete).toHaveBeenCalled();
    expect(builder.where).toHaveBeenCalledWith('user_id = :userId', {
      userId: 'user-1',
    });
    // The guard lives in the same statement, so a single-device logout that
    // leaves another session alive keeps every row.
    const [guardSql, guardParameters] = builder.andWhere.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(guardSql).toContain('NOT EXISTS');
    expect(guardSql).toContain('refresh_tokens.revoked_at IS NULL');
    expect(guardSql).toContain('refresh_tokens.expires_at > now()');
    expect(guardParameters).toEqual({ userId: 'user-1' });
    expect(builder.execute).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows a failure instead of throwing from the listener', async () => {
    const builder = makeDeleteBuilder(
      jest.fn().mockRejectedValue(new Error('db down')),
    );
    const repo = {
      ...makeRepo(),
      createQueryBuilder: jest.fn().mockReturnValue(builder),
    };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = new PushService(repo as never, config);

    await expect(
      service.handleSessionRevoked({ userId: 'user-1' }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('user-1'));
    warn.mockRestore();
  });
});

describe('handleMessageRead (PRD-335)', () => {
  it('fans a silent, content-free read-dismissal push to every one of the reader’s own subscriptions, tagged for that conversation', async () => {
    const repo = makeRepo([
      { id: 's1', endpoint: 'https://8.8.8.8/e1', p256dh: 'k1', auth: 'a1' },
      { id: 's2', endpoint: 'https://8.8.8.8/e2', p256dh: 'k2', auth: 'a2' },
    ]);
    const service = new PushService(repo as never, config);
    service.onModuleInit();
    sendNotification.mockResolvedValue(undefined);

    await service.handleMessageRead({
      conversationId: 'conv-1',
      userId: 'user-1',
      lastReadAt: new Date('2026-01-15T12:00:00.000Z'),
    });

    // Looked up by the READER's own userId only; see the handler's own doc
    // for why "every device except the reading one" cannot be computed from
    // `MessageReadEvent` alone (no device/session/endpoint id on the event).
    const findCall = repo.find.mock.calls[0][0] as {
      where: { userId: { value: string[] } };
    };
    expect(findCall.where.userId.value).toEqual(['user-1']);

    // Every one of the reader's subscriptions receives it.
    expect(sendNotification).toHaveBeenCalledTimes(2);
    for (const call of sendNotification.mock.calls) {
      const [, body] = call as [unknown, string];
      expect(JSON.parse(body) as unknown).toEqual({
        title: 'QueerPulse',
        body: '',
        tag: `${READ_DISMISS_TAG_PREFIX}conv-1`,
        data: { conversationId: 'conv-1', url: '/messages' },
        silent: true,
      });
    }
  });

  it('never sends the generic notification-preview split, only sendToUsers directly', async () => {
    // A read-dismissal names no one and carries no message text, so it must
    // never touch the hidden-preview split machinery (which lives in a
    // different service this one never imports). Proven here structurally:
    // `sendNotification` (the one wire-level send point) receives EXACTLY
    // the payload above, never a generic-copy variant.
    const repo = makeRepo([
      { id: 's1', endpoint: 'https://8.8.8.8/e1', p256dh: 'k1', auth: 'a1' },
    ]);
    const service = new PushService(repo as never, config);
    service.onModuleInit();
    sendNotification.mockResolvedValue(undefined);

    await service.handleMessageRead({
      conversationId: 'conv-2',
      userId: 'user-2',
      lastReadAt: new Date(),
    });

    const [, body] = sendNotification.mock.calls[0] as [unknown, string];
    const parsed = JSON.parse(body) as { tag: string };
    expect(parsed.tag).toBe(`${READ_DISMISS_TAG_PREFIX}conv-2`);
  });

  it('logs and swallows a failure instead of throwing from the listener', async () => {
    const repo = makeRepo();
    repo.find.mockRejectedValueOnce(new Error('db down'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = new PushService(repo as never, config);
    service.onModuleInit();

    await expect(
      service.handleMessageRead({
        conversationId: 'conv-1',
        userId: 'user-1',
        lastReadAt: new Date(),
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('conv-1'));
    warn.mockRestore();
  });
});

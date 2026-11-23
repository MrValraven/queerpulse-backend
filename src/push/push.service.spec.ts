import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Brackets, ObjectLiteral, WhereExpressionBuilder } from 'typeorm';
import {
  PushService,
  READ_DISMISS_TAG_PREFIX,
  isApplePushEndpoint,
  pushRetryDelayMs,
} from './push.service';

// The SSRF guard resolves DNS for hostnames. Apple endpoints resolve to a
// fixed public address here so the specs need no network; every other URL
// (the IP literals the specs use) goes through the real guard.
jest.mock('../link-preview/ssrf', () => {
  const actual = jest.requireActual<typeof import('../link-preview/ssrf')>(
    '../link-preview/ssrf',
  );
  return {
    ...actual,
    assertPublicUrl: (rawUrl: string) =>
      new URL(rawUrl).hostname.endsWith('push.apple.com')
        ? Promise.resolve({
            url: new URL(rawUrl),
            address: '8.8.4.4',
            family: 4,
          })
        : actual.assertPublicUrl(rawUrl),
  };
});

const sendNotification = jest.fn<Promise<unknown>, unknown[]>();
const setVapidDetails = jest.fn<void, unknown[]>();
jest.mock('web-push', () => ({
  __esModule: true,
  default: {
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

/** The read `sendToUsers` builds: every recipient's rows in one query. */
interface DeliveryReadBuilder {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  getRawMany: jest.Mock;
}

/** The best-effort delete of ended-session rows. */
interface EndedSessionDeleteBuilder {
  delete: jest.Mock;
  from: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  execute: jest.Mock;
}

function makeDeliveryReadBuilder(rows: unknown[]): DeliveryReadBuilder {
  const builder: DeliveryReadBuilder = {
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  };
  builder.select.mockReturnValue(builder);
  builder.addSelect.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  return builder;
}

function makeEndedSessionDeleteBuilder(): EndedSessionDeleteBuilder {
  const builder: EndedSessionDeleteBuilder = {
    delete: jest.fn(),
    from: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  builder.delete.mockReturnValue(builder);
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.andWhere.mockReturnValue(builder);
  return builder;
}

function makeRepo(rows: unknown[] = []) {
  const readBuilder = makeDeliveryReadBuilder(rows);
  const endedSessionDeleteBuilder = makeEndedSessionDeleteBuilder();
  return {
    find: jest.fn().mockResolvedValue(rows),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    readBuilder,
    endedSessionDeleteBuilder,
    // The read names an alias; the ended-session delete names none.
    createQueryBuilder: jest.fn((alias?: string) =>
      alias ? readBuilder : endedSessionDeleteBuilder,
    ),
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
  // SEC-12: a delivery leaves `last_used_at` alone. Only the device's own
  // re-subscribe moves the retention clock.
  expect(repo.update).not.toHaveBeenCalled();
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

describe('sendToUsers and rows whose session ended', () => {
  const ENDED_SESSION_CHECK =
    'push_subscriptions.session_family_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM refresh_tokens WHERE refresh_tokens.user_id = push_subscriptions.user_id AND refresh_tokens.family_id = push_subscriptions.session_family_id AND refresh_tokens.revoked_at IS NULL AND refresh_tokens.expires_at > now())';

  it('reads every recipient’s rows in one query that flags a linked row with no live refresh row', async () => {
    const repo = makeRepo([]);
    const service = new PushService(repo as never, config);
    service.onModuleInit();

    await service.sendToUsers(['user-1', 'user-2'], payload);

    expect(repo.createQueryBuilder).toHaveBeenCalledWith('push_subscriptions');
    expect(repo.readBuilder.addSelect).toHaveBeenCalledWith(
      `(${ENDED_SESSION_CHECK})`,
      'is_session_ended',
    );
    expect(repo.readBuilder.where).toHaveBeenCalledWith(
      'push_subscriptions.user_id IN (:...userIds)',
      { userIds: ['user-1', 'user-2'] },
    );
    expect(repo.endedSessionDeleteBuilder.execute).not.toHaveBeenCalled();
  });

  it('skips a row whose session ended, deletes it under the same check, and still sends to the live rows', async () => {
    const repo = makeRepo([
      {
        id: 's-live',
        endpoint: 'https://8.8.8.8/live',
        p256dh: 'k1',
        auth: 'a1',
        is_session_ended: false,
      },
      {
        id: 's-ended',
        endpoint: 'https://8.8.8.8/ended',
        p256dh: 'k2',
        auth: 'a2',
        is_session_ended: true,
      },
    ]);
    const service = new PushService(repo as never, config);
    service.onModuleInit();
    sendNotification.mockResolvedValue(undefined);

    await service.sendToUsers(['user-1'], payload);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [subscription] = sendNotification.mock.calls[0] as [
      { endpoint: string },
    ];
    expect(subscription.endpoint).toBe('https://8.8.8.8/live');
    const deleteBuilder = repo.endedSessionDeleteBuilder;
    expect(deleteBuilder.delete).toHaveBeenCalled();
    expect(deleteBuilder.where).toHaveBeenCalledWith('id IN (:...rowIds)', {
      rowIds: ['s-ended'],
    });
    // Checked again inside the delete, so a device that re-subscribed under a
    // live session in between keeps its row.
    expect(deleteBuilder.andWhere).toHaveBeenCalledWith(ENDED_SESSION_CHECK);
    expect(deleteBuilder.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps sending to the live rows when the delete fails, and logs it', async () => {
    const repo = makeRepo([
      {
        id: 's-live',
        endpoint: 'https://8.8.8.8/live',
        p256dh: 'k1',
        auth: 'a1',
        is_session_ended: false,
      },
      {
        id: 's-ended',
        endpoint: 'https://8.8.8.8/ended',
        p256dh: 'k2',
        auth: 'a2',
        is_session_ended: true,
      },
    ]);
    repo.endedSessionDeleteBuilder.execute.mockRejectedValueOnce(
      new Error('db down'),
    );
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = new PushService(repo as never, config);
    service.onModuleInit();
    sendNotification.mockResolvedValue(undefined);

    await service.sendToUsers(['user-1'], payload);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('whose session ended'),
    );
    warn.mockRestore();
  });
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

  it('links the row to the caller’s session and stamps the client-seen time', async () => {
    const repo = makeRepo();
    const service = new PushService(repo as never, config);

    await service.saveSubscription('user-1', input, 'agent', 'family-1');

    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        endpoint: 'e1',
        sessionFamilyId: 'family-1',
        lastUsedAt: expect.any(Date) as unknown,
      }),
      ['endpoint'],
    );
  });

  it('writes an explicit NULL link when the caller names no session', async () => {
    const repo = makeRepo();
    const service = new PushService(repo as never, config);

    await service.saveSubscription('user-1', input);

    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ sessionFamilyId: null }),
      ['endpoint'],
    );
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

  it.each([
    [401, 'VAPID key rejected'],
    [403, 'VAPID key rejected'],
    [404, 'expired'],
    [410, 'expired'],
  ])('words the prune log for a %i as "%s"', async (statusCode, wording) => {
    const repo = oneRow();
    const service = new PushService(repo as never, config);
    service.onModuleInit();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    sendNotification.mockRejectedValue({ statusCode });

    await service.sendToUser('user-1', payload);

    const lines = [...log.mock.calls, ...warn.mock.calls].map((call) =>
      String(call[0]),
    );
    expect(lines.some((line) => line.includes(wording))).toBe(true);
    const otherWording =
      wording === 'expired' ? 'VAPID key rejected' : 'expired';
    expect(lines.some((line) => line.includes(otherWording))).toBe(false);
    log.mockRestore();
    warn.mockRestore();
  });

  it('retries once after a 503 and keeps the row when the retry lands', async () => {
    const repo = oneRow();
    const service = new PushService(repo as never, config);
    service.onModuleInit();
    sendNotification
      .mockRejectedValueOnce(throttled(503))
      .mockResolvedValueOnce(undefined);

    await service.sendToUser('user-1', payload);

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(repo.update).not.toHaveBeenCalled();
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
  interface RecordedGuard {
    joiner: 'where' | 'orWhere';
    sql: string;
    parameters: Record<string, unknown>;
  }

  /** Records each branch of the bracket, the way a real query builder takes it. */
  class GuardRecorder implements WhereExpressionBuilder {
    readonly recorded: RecordedGuard[] = [];

    where(condition: unknown, parameters?: ObjectLiteral): this {
      return this.record('where', condition, parameters);
    }

    andWhere(condition: unknown, parameters?: ObjectLiteral): this {
      return this.record('where', condition, parameters);
    }

    orWhere(condition: unknown, parameters?: ObjectLiteral): this {
      return this.record('orWhere', condition, parameters);
    }

    whereInIds(): this {
      throw new Error('The session guard never filters by id');
    }

    andWhereInIds(): this {
      throw new Error('The session guard never filters by id');
    }

    orWhereInIds(): this {
      throw new Error('The session guard never filters by id');
    }

    private record(
      joiner: RecordedGuard['joiner'],
      condition: unknown,
      parameters: ObjectLiteral = {},
    ): this {
      if (typeof condition !== 'string') {
        throw new Error('Expected each guard branch to be raw SQL');
      }
      this.recorded.push({ joiner, sql: condition, parameters });
      return this;
    }
  }

  /**
   * The delete's guard is one bracketed `A OR B`. Replays the bracket's factory
   * against a recorder so each branch's SQL can be asserted on its own:
   * the unlinked-row branch first, then the linked-row branch.
   */
  function readGuards(builder: {
    andWhere: jest.Mock<unknown, unknown[]>;
  }): [RecordedGuard, RecordedGuard] {
    const bracket: unknown = builder.andWhere.mock.calls[0]?.[0];
    if (!(bracket instanceof Brackets)) {
      throw new Error('Expected the delete guard to be one Brackets group');
    }
    const recorder = new GuardRecorder();
    bracket.whereFactory(recorder);
    const [unlinkedGuard, linkedGuard] = recorder.recorded;
    if (!unlinkedGuard || !linkedGuard) {
      throw new Error('Expected two guard branches');
    }
    return [unlinkedGuard, linkedGuard];
  }

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
    // Both guards live in the same statement as the delete.
    const [unlinkedGuard, linkedGuard] = readGuards(builder);
    // An unlinked row goes only once the member has no live session at all,
    // so a single-device logout that leaves another session alive keeps it.
    expect(unlinkedGuard.sql).toContain('NOT EXISTS');
    expect(unlinkedGuard.sql).toContain('refresh_tokens.user_id = :userId');
    expect(unlinkedGuard.sql).toContain('refresh_tokens.revoked_at IS NULL');
    expect(unlinkedGuard.sql).toContain('refresh_tokens.expires_at > now()');
    expect(unlinkedGuard.sql).not.toContain('session_family_id');
    expect(unlinkedGuard.parameters).toEqual({ userId: 'user-1' });
    expect(builder.execute).toHaveBeenCalledTimes(1);
    expect(linkedGuard.parameters).toEqual({ userId: 'user-1' });
  });

  it('deletes a linked row once its own session has no live row (SEC-12)', async () => {
    const builder = makeDeleteBuilder(
      jest.fn().mockResolvedValue({ affected: 1 }),
    );
    const repo = {
      ...makeRepo(),
      createQueryBuilder: jest.fn().mockReturnValue(builder),
    };
    const service = new PushService(repo as never, config);

    // "Sign out this device" emits for a member who keeps other sessions.
    await service.handleSessionRevoked({
      userId: 'user-1',
      sessionId: 'family-1',
    });

    const [, linkedGuard] = readGuards(builder);
    expect(linkedGuard.joiner).toBe('orWhere');
    expect(linkedGuard.sql).toContain(
      'push_subscriptions.session_family_id IS NOT NULL',
    );
    expect(linkedGuard.sql).toContain(
      'refresh_tokens.family_id = push_subscriptions.session_family_id',
    );
    expect(linkedGuard.sql).toContain('refresh_tokens.revoked_at IS NULL');
    expect(linkedGuard.sql).toContain('refresh_tokens.expires_at > now()');
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
    expect(repo.readBuilder.where).toHaveBeenCalledWith(
      'push_subscriptions.user_id IN (:...userIds)',
      { userIds: ['user-1'] },
    );

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

  it('sends to a non-Apple subscription and skips an Apple one', async () => {
    const repo = makeRepo([
      { id: 's1', endpoint: 'https://8.8.8.8/e1', p256dh: 'k1', auth: 'a1' },
      {
        id: 's2',
        endpoint: 'https://web.push.apple.com/e2',
        p256dh: 'k2',
        auth: 'a2',
      },
    ]);
    const service = new PushService(repo as never, config);
    service.onModuleInit();
    sendNotification.mockResolvedValue(undefined);

    await service.handleMessageRead({
      conversationId: 'conv-1',
      userId: 'user-1',
      lastReadAt: new Date(),
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [subscription] = sendNotification.mock.calls[0] as [
      { endpoint: string },
    ];
    expect(subscription.endpoint).toBe('https://8.8.8.8/e1');
  });

  it('logs and swallows a failure instead of throwing from the listener', async () => {
    const repo = makeRepo();
    repo.readBuilder.getRawMany.mockRejectedValueOnce(new Error('db down'));
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

describe('isApplePushEndpoint', () => {
  it.each([
    'https://web.push.apple.com/QAbc123',
    'https://api.push.apple.com/3/device/abc',
  ])('is true for the Apple host in %s', (endpoint) => {
    expect(isApplePushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://push.apple.com.example.org/abc',
    'not a url',
  ])('is false for %s', (endpoint) => {
    expect(isApplePushEndpoint(endpoint)).toBe(false);
  });
});

describe('sendToUsers Apple endpoint handling', () => {
  it('sends to an Apple subscription when no options are given', async () => {
    const repo = makeRepo([
      {
        id: 's1',
        endpoint: 'https://web.push.apple.com/e1',
        p256dh: 'k1',
        auth: 'a1',
      },
    ]);
    const service = new PushService(repo as never, config);
    service.onModuleInit();
    sendNotification.mockResolvedValue(undefined);

    await service.sendToUsers(['user-1'], payload);

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});

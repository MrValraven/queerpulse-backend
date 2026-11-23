import { ThrottlerStorageService } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import type { ExecutionContext, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { HttpThrottlerGuard } from '../../security/http-throttler.guard';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  EmailCodeJoinRequestDailyAddressThrottlerGuard,
  EmailCodeRequestAddressThrottlerGuard,
  EmailCodeRequestIpThrottlerGuard,
  EmailCodeVerifyIpThrottlerGuard,
} from './email-code-throttler.guards';
import { EmailCodeController } from './email-code.controller';
import { EmailCodeRefusedError } from './email-code-refusal';
import { deriveEmailCodeTrustedRequesterKey } from './email-code-secret';
import { mintTrustedRequesterToken } from './email-code-trusted-requester';

/** Exposes the `protected` members under test without weakening the real API. */
interface Exposed {
  throttlerConfig?: ConfigService;
  publicGetTracker(req: Record<string, unknown>): Promise<string>;
  publicHandleRequest(requestProps: ThrottlerRequest): Promise<boolean>;
  publicThrow(
    context: ExecutionContext,
    detail: { timeToBlockExpire: number },
  ): Promise<void>;
}

/** The protected members every email code guard inherits and overrides. */
interface GuardInternals {
  throttlerConfig?: ConfigService;
  getTracker(req: Record<string, unknown>): Promise<string>;
  handleRequest(requestProps: ThrottlerRequest): Promise<boolean>;
  throwThrottlingException(
    context: ExecutionContext,
    detail: { timeToBlockExpire: number },
  ): Promise<void>;
}

type GuardConstructor = new (...args: unknown[]) => GuardInternals;

function expose(GuardClass: unknown): Exposed {
  const Testable = class extends (GuardClass as GuardConstructor) {
    publicGetTracker(req: Record<string, unknown>): Promise<string> {
      return this.getTracker(req);
    }
    publicHandleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
      return this.handleRequest(requestProps);
    }
    publicThrow(
      context: ExecutionContext,
      detail: { timeToBlockExpire: number },
    ): Promise<void> {
      return this.throwThrottlingException(context, detail);
    }
  };
  return new Testable({}, {}, {});
}

type HandleRequestHost = {
  handleRequest(requestProps: ThrottlerRequest): Promise<boolean>;
};

async function limitsHandedToBase(
  guard: Exposed,
): Promise<Record<string, unknown>> {
  const superHandleRequest = jest
    .spyOn(
      HttpThrottlerGuard.prototype as unknown as HandleRequestHost,
      'handleRequest',
    )
    .mockResolvedValue(true);
  await guard.publicHandleRequest({
    context: {} as never,
    limit: 999,
    ttl: 1,
    blockDuration: 1,
    throttler: {} as never,
    generateKey: jest.fn(),
  } as unknown as ThrottlerRequest);
  const firstCall = superHandleRequest.mock.calls[0];
  if (!firstCall) {
    throw new Error('the base handler was never called');
  }
  const handed = firstCall[0] as unknown as Record<string, unknown>;
  superHandleRequest.mockRestore();
  return handed;
}

async function caught(promise: Promise<void>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected the guard to throw');
}

describe('email code throttler guards', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("address tracker is the same for ' Sam@Example.com ' and 'sam@example.com' from one IP, and never contains the address", async () => {
    const guard = expose(EmailCodeRequestAddressThrottlerGuard);
    const first = await guard.publicGetTracker({
      ip: '203.0.113.9',
      body: { email: ' Sam@Example.com ' },
    });
    const second = await guard.publicGetTracker({
      ip: '203.0.113.9',
      body: { email: 'sam@example.com' },
    });
    expect(first).toBe(second);
    expect(first).not.toContain('sam');
    expect(first).not.toContain('example');
  });

  it('address tracker differs by IP', async () => {
    const guard = expose(EmailCodeRequestAddressThrottlerGuard);
    const body = { email: 'sam@example.com' };
    const one = await guard.publicGetTracker({ ip: '203.0.113.9', body });
    const other = await guard.publicGetTracker({ ip: '203.0.113.10', body });
    expect(one).not.toBe(other);
  });

  it('address tracker copes with a missing or non-string email', async () => {
    const guard = expose(EmailCodeRequestAddressThrottlerGuard);
    const missing = await guard.publicGetTracker({ ip: '203.0.113.9' });
    const numeric = await guard.publicGetTracker({
      ip: '203.0.113.9',
      body: { email: 42 },
    });
    expect(missing).toBe(numeric);
    expect(missing.startsWith('email-code-address:')).toBe(true);
  });

  it('ip trackers carry the email-code prefix', async () => {
    const request = { ip: '203.0.113.9' };
    await expect(
      expose(EmailCodeRequestIpThrottlerGuard).publicGetTracker(request),
    ).resolves.toBe('email-code-ip:203.0.113.9');
    await expect(
      expose(EmailCodeVerifyIpThrottlerGuard).publicGetTracker(request),
    ).resolves.toBe('email-code-ip:203.0.113.9');
  });

  it('each guard hands its own limit and window to the base handler', async () => {
    expect(
      await limitsHandedToBase(expose(EmailCodeRequestAddressThrottlerGuard)),
    ).toMatchObject({ limit: 5, ttl: 3_600_000, blockDuration: 3_600_000 });
    expect(
      await limitsHandedToBase(expose(EmailCodeRequestIpThrottlerGuard)),
    ).toMatchObject({ limit: 60, ttl: 3_600_000, blockDuration: 3_600_000 });
    expect(
      await limitsHandedToBase(expose(EmailCodeVerifyIpThrottlerGuard)),
    ).toMatchObject({ limit: 60, ttl: 600_000, blockDuration: 600_000 });
  });

  it('a blocked request per IP and address answers too_many_codes with retryAt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const error = await caught(
      expose(EmailCodeRequestAddressThrottlerGuard).publicThrow(
        {} as ExecutionContext,
        { timeToBlockExpire: 90 },
      ),
    );
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({
      reason: 'too_many_codes',
      retryAt: '2026-10-26T12:01:30.000Z',
    });
  });

  it('a blocked request per IP answers network_busy with retryAt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const error = await caught(
      expose(EmailCodeRequestIpThrottlerGuard).publicThrow(
        {} as ExecutionContext,
        { timeToBlockExpire: 90 },
      ),
    );
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({
      reason: 'network_busy',
      retryAt: '2026-10-26T12:01:30.000Z',
    });
  });

  it('join-request daily tracker is keyed on IP and normalized address, apart from the hourly bucket, and never contains the address', async () => {
    const daily = expose(EmailCodeJoinRequestDailyAddressThrottlerGuard);
    const hourly = expose(EmailCodeRequestAddressThrottlerGuard);
    const first = await daily.publicGetTracker({
      ip: '203.0.113.9',
      body: { email: ' Sam@Example.com ' },
    });
    const sameAddress = await daily.publicGetTracker({
      ip: '203.0.113.9',
      body: { email: 'sam@example.com' },
    });
    const otherIp = await daily.publicGetTracker({
      ip: '203.0.113.10',
      body: { email: 'sam@example.com' },
    });
    const hourlyTracker = await hourly.publicGetTracker({
      ip: '203.0.113.9',
      body: { email: 'sam@example.com' },
    });
    expect(first).toBe(sameAddress);
    expect(first).not.toBe(otherIp);
    expect(first).not.toBe(hourlyTracker);
    expect(first.startsWith('email-code-join-request-day:')).toBe(true);
    expect(first).not.toContain('sam');
    expect(first).not.toContain('example');
  });

  it('join-request daily guard allows 3 per IP and address over 24 hours', async () => {
    expect(
      await limitsHandedToBase(
        expose(EmailCodeJoinRequestDailyAddressThrottlerGuard),
      ),
    ).toMatchObject({ limit: 3, ttl: 86_400_000, blockDuration: 86_400_000 });
  });

  it('a blocked join-request code past the daily bucket answers too_many_codes with retryAt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const error = await caught(
      expose(EmailCodeJoinRequestDailyAddressThrottlerGuard).publicThrow(
        {} as ExecutionContext,
        { timeToBlockExpire: 3_600 },
      ),
    );
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({
      reason: 'too_many_codes',
      retryAt: '2026-10-26T13:00:00.000Z',
    });
  });

  it('only the join-request code route carries the daily guard', () => {
    const prototype = EmailCodeController.prototype as unknown as Record<
      string,
      unknown
    >;
    const guardsOf = (handlerName: string): unknown[] =>
      (Reflect.getMetadata(GUARDS_METADATA, prototype[handlerName] as object) ??
        []) as unknown[];
    expect(guardsOf('joinRequestCodeRequest')).toEqual([
      EmailCodeRequestIpThrottlerGuard,
      EmailCodeRequestAddressThrottlerGuard,
      EmailCodeJoinRequestDailyAddressThrottlerGuard,
    ]);
    for (const handlerName of Object.getOwnPropertyNames(prototype)) {
      if (handlerName === 'joinRequestCodeRequest') continue;
      expect(guardsOf(handlerName)).not.toContain(
        EmailCodeJoinRequestDailyAddressThrottlerGuard,
      );
    }
  });

  it('a blocked verify per IP answers network_busy with retryAt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const error = await caught(
      expose(EmailCodeVerifyIpThrottlerGuard).publicThrow(
        {} as ExecutionContext,
        { timeToBlockExpire: 90 },
      ),
    );
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({
      reason: 'network_busy',
      retryAt: '2026-10-26T12:01:30.000Z',
    });
  });
});

// SEC-11: a stranger on the member's public IP spends the ordinary IP+address
// bucket; the member's trusted browser keeps its own.
describe('email code IP+address guards and the trusted-requester cookie', () => {
  const CODE_SECRET = 'email-code-secret-for-the-guard-spec';
  const SHARED_IP = '198.51.100.20';
  const ADDRESS = 'sam@example.com';
  const NOW = new Date('2026-11-23T12:00:00Z');

  interface DrivenGuard {
    throttlerConfig?: ConfigService;
    onModuleInit(): Promise<void>;
    canActivate(context: ExecutionContext): Promise<boolean>;
  }

  type DrivenGuardConstructor = new (
    options: unknown,
    storage: ThrottlerStorageService,
    reflector: Reflector,
  ) => DrivenGuard;

  type RequestShape = {
    ip: string;
    headers: Record<string, string>;
    body: { email: string };
    cookies: Record<string, string>;
  };

  let storage: ThrottlerStorageService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    storage = new ThrottlerStorageService();
  });

  afterEach(() => {
    storage.onApplicationShutdown();
    jest.useRealTimers();
  });

  async function drivenGuard(GuardClass: unknown): Promise<DrivenGuard> {
    const guard = new (GuardClass as DrivenGuardConstructor)(
      { throttlers: [{ name: 'default', ttl: 60_000, limit: 1_000 }] },
      storage,
      new Reflector(),
    );
    guard.throttlerConfig = new ConfigService({
      email: { codeSecret: CODE_SECRET },
      app: { nodeEnv: 'test' },
    });
    await guard.onModuleInit();
    return guard;
  }

  function contextFor(
    req: RequestShape,
    handlerName: string,
  ): ExecutionContext {
    const prototype = EmailCodeController.prototype as unknown as Record<
      string,
      () => unknown
    >;
    const handler = prototype[handlerName];
    const context = {
      getType: () => 'http',
      getClass: () => EmailCodeController,
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({ header: jest.fn() }),
      }),
    };
    return context as unknown as ExecutionContext;
  }

  function requestWith(cookies: Record<string, string> = {}): RequestShape {
    return { ip: SHARED_IP, headers: {}, body: { email: ADDRESS }, cookies };
  }

  async function outcomeOf(promise: Promise<boolean>): Promise<string> {
    try {
      return (await promise) ? 'allowed' : 'refused';
    } catch (error) {
      if (error instanceof EmailCodeRefusedError) return error.reason;
      throw error;
    }
  }

  const trustedToken = () =>
    mintTrustedRequesterToken(
      deriveEmailCodeTrustedRequesterKey(CODE_SECRET, undefined, 'test'),
      ADDRESS,
      NOW,
    );

  const forgedToken = () => {
    const [expiry] = trustedToken().split('.');
    return `${expiry}.${'A'.repeat(43)}`;
  };

  it.each<[string, unknown, string, number]>([
    [
      'the hourly sign-in bucket',
      EmailCodeRequestAddressThrottlerGuard,
      'request',
      5,
    ],
    [
      'the daily join-request bucket',
      EmailCodeJoinRequestDailyAddressThrottlerGuard,
      'joinRequestCodeRequest',
      3,
    ],
  ])(
    'a trusted request passes after a stranger on the same IP spends %s',
    async (_label, GuardClass, handlerName, limit) => {
      const guard = await drivenGuard(GuardClass);
      for (let attempt = 0; attempt < limit; attempt++) {
        await expect(
          outcomeOf(guard.canActivate(contextFor(requestWith(), handlerName))),
        ).resolves.toBe('allowed');
      }
      await expect(
        outcomeOf(guard.canActivate(contextFor(requestWith(), handlerName))),
      ).resolves.toBe('too_many_codes');

      await expect(
        outcomeOf(
          guard.canActivate(
            contextFor(
              requestWith({ email_code_trusted: trustedToken() }),
              handlerName,
            ),
          ),
        ),
      ).resolves.toBe('allowed');
    },
  );

  it('a forged trusted cookie uses the ordinary bucket and is refused once it is spent', async () => {
    const guard = await drivenGuard(EmailCodeRequestAddressThrottlerGuard);
    for (let attempt = 0; attempt < 5; attempt++) {
      await guard.canActivate(contextFor(requestWith(), 'request'));
    }

    await expect(
      outcomeOf(
        guard.canActivate(
          contextFor(
            requestWith({ email_code_trusted: forgedToken() }),
            'request',
          ),
        ),
      ),
    ).resolves.toBe('too_many_codes');
  });

  it('the trusted bucket caps itself at the same per-IP limit', async () => {
    const guard = await drivenGuard(EmailCodeRequestAddressThrottlerGuard);
    const trusted = () =>
      contextFor(
        requestWith({ email_code_trusted: trustedToken() }),
        'request',
      );
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(outcomeOf(guard.canActivate(trusted()))).resolves.toBe(
        'allowed',
      );
    }
    await expect(outcomeOf(guard.canActivate(trusted()))).resolves.toBe(
      'too_many_codes',
    );
  });

  it('keys the trusted bucket on the IP+address digest and leaves the cookie value out', async () => {
    const guard = expose(EmailCodeRequestAddressThrottlerGuard);
    guard.throttlerConfig = new ConfigService({
      email: { codeSecret: CODE_SECRET },
      app: { nodeEnv: 'test' },
    });
    const token = trustedToken();
    const [, mac = ''] = token.split('.');

    const ordinary = await guard.publicGetTracker(requestWith());
    const forged = await guard.publicGetTracker(
      requestWith({ email_code_trusted: forgedToken() }),
    );
    const trusted = await guard.publicGetTracker(
      requestWith({ email_code_trusted: token }),
    );
    const otherAddress = await guard.publicGetTracker({
      ...requestWith({ email_code_trusted: token }),
      body: { email: 'lee@example.com' },
    });

    expect(forged).toBe(ordinary);
    expect(otherAddress.startsWith('email-code-address:')).toBe(true);
    expect(trusted.startsWith('email-code-address-trusted:')).toBe(true);
    expect(trusted.split(':')[1]).toBe(ordinary.split(':')[1]);
    expect(trusted).not.toContain(mac);
    expect(trusted).not.toContain('sam');
  });
});

import type { ThrottlerRequest } from '@nestjs/throttler';
import type { ExecutionContext, HttpException } from '@nestjs/common';
import { HttpThrottlerGuard } from '../../security/http-throttler.guard';
import {
  EmailCodeRequestAddressThrottlerGuard,
  EmailCodeRequestIpThrottlerGuard,
  EmailCodeVerifyIpThrottlerGuard,
} from './email-code-throttler.guards';

/** Exposes the `protected` members under test without weakening the real API. */
interface Exposed {
  publicGetTracker(req: Record<string, unknown>): Promise<string>;
  publicHandleRequest(requestProps: ThrottlerRequest): Promise<boolean>;
  publicThrow(
    context: ExecutionContext,
    detail: { timeToBlockExpire: number },
  ): Promise<void>;
}

/** The protected members every email code guard inherits and overrides. */
interface GuardInternals {
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

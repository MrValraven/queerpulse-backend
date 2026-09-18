import type {
  ThrottlerModuleOptions,
  ThrottlerRequest,
  ThrottlerStorage,
} from '@nestjs/throttler';
import type { Reflector } from '@nestjs/core';
import { HttpThrottlerGuard } from '../security/http-throttler.guard';
import { SocketTicketThrottlerGuard } from './socket-ticket-throttler.guard';

/** Exposes the two `protected` members under test without weakening the
 *  guard's real (protected) API. */
class TestableGuard extends SocketTicketThrottlerGuard {
  publicGetTracker(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
  publicHandleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    return this.handleRequest(requestProps);
  }
}

/** Only `getTracker` and `handleRequest` run here, and neither touches the
 *  options, storage or reflector the base `ThrottlerGuard` constructor wants. */
function makeGuard(): TestableGuard {
  return new TestableGuard(
    {} as ThrottlerModuleOptions,
    {} as ThrottlerStorage,
    {} as Reflector,
  );
}

/** `handleRequest` is `protected`, so `jest.spyOn` cannot name it on the
 *  real prototype type. */
type HandleRequestHost = {
  handleRequest(requestProps: ThrottlerRequest): Promise<boolean>;
};

describe('SocketTicketThrottlerGuard', () => {
  it('keys the tracker on the authenticated user id rather than the request IP', async () => {
    const guard = makeGuard();
    const tracker = await guard.publicGetTracker({
      user: { userId: 'user-1' },
      ip: '203.0.113.9',
    });
    expect(tracker).toBe('socket-ticket:user-1');
  });

  it('falls back to the client IP when no authenticated user is present', async () => {
    const guard = makeGuard();
    const tracker = await guard.publicGetTracker({ ip: '203.0.113.9' });
    expect(tracker).toBe('203.0.113.9');
  });

  it('overrides limit/ttl/blockDuration on every request rather than trusting route metadata', async () => {
    const guard = makeGuard();
    const superHandleRequest = jest
      .spyOn(
        HttpThrottlerGuard.prototype as unknown as HandleRequestHost,
        'handleRequest',
      )
      .mockResolvedValue(true);

    const requestProps = {
      context: {} as never,
      limit: 999, // whatever a route-level @Throttle (or its absence) supplied
      ttl: 1,
      blockDuration: 1,
      throttler: {} as never,
      generateKey: jest.fn(),
    } as unknown as ThrottlerRequest;

    await guard.publicHandleRequest(requestProps);

    expect(superHandleRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 10,
        ttl: 60_000,
        blockDuration: 60_000,
      }),
    );
    superHandleRequest.mockRestore();
  });
});

import type { ThrottlerRequest } from '@nestjs/throttler';
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

describe('SocketTicketThrottlerGuard', () => {
  it('keys the tracker on the authenticated user id rather than the request IP', async () => {
    const guard = new TestableGuard();
    const tracker = await guard.publicGetTracker({
      user: { userId: 'user-1' },
      ip: '203.0.113.9',
    });
    expect(tracker).toBe('socket-ticket:user-1');
  });

  it('falls back to the client IP when no authenticated user is present', async () => {
    const guard = new TestableGuard();
    const tracker = await guard.publicGetTracker({ ip: '203.0.113.9' });
    expect(tracker).toBe('203.0.113.9');
  });

  it('overrides limit/ttl/blockDuration on every request rather than trusting route metadata', async () => {
    const guard = new TestableGuard();
    const superHandleRequest = jest
      .spyOn(HttpThrottlerGuard.prototype, 'handleRequest')
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

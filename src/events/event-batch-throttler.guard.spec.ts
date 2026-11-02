import type {
  ThrottlerModuleOptions,
  ThrottlerRequest,
  ThrottlerStorage,
} from '@nestjs/throttler';
import type { Reflector } from '@nestjs/core';
import { HttpThrottlerGuard } from '../security/http-throttler.guard';
import { EventBatchThrottlerGuard } from './event-batch-throttler.guard';

/** Exposes the two `protected` members under test without weakening the
 *  guard's real (protected) API. */
class TestableGuard extends EventBatchThrottlerGuard {
  publicGetTracker(request: Record<string, unknown>): Promise<string> {
    return this.getTracker(request);
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

describe('EventBatchThrottlerGuard', () => {
  it('keys the tracker on the member id', async () => {
    const guard = makeGuard();
    const tracker = await guard.publicGetTracker({
      user: { userId: 'user-1' },
      ip: '203.0.113.9',
    });
    expect(tracker).toBe('event-batch:user-1');
  });

  it('falls back to the client address without a member', async () => {
    const guard = makeGuard();
    const tracker = await guard.publicGetTracker({ ip: '203.0.113.9' });
    expect(tracker).toBe('203.0.113.9');
  });

  it('holds every member to five batches per ten minutes', async () => {
    const guard = makeGuard();
    const superHandleRequest = jest
      .spyOn(
        HttpThrottlerGuard.prototype as unknown as HandleRequestHost,
        'handleRequest',
      )
      .mockResolvedValue(true);

    const requestProps = {
      context: {} as never,
      limit: 999, // whatever the route metadata handed in
      ttl: 1,
      blockDuration: 1,
      throttler: {} as never,
      generateKey: jest.fn(),
    } as unknown as ThrottlerRequest;

    await guard.publicHandleRequest(requestProps);

    expect(superHandleRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 5,
        ttl: 600_000,
        blockDuration: 600_000,
      }),
    );
    superHandleRequest.mockRestore();
  });
});

import { NotificationType } from './entities/notification.entity';
import { bundleKeyFor } from './notification-bundling';

describe('bundleKeyFor for admin queue arrivals', () => {
  it('collapses two arrivals in the same queue', () => {
    const first = bundleKeyFor(NotificationType.AdminQueueItem, {
      source: 'admin',
      queue: 'invite_requests',
      itemId: 'a1111111-1111-1111-1111-111111111111',
    });
    const second = bundleKeyFor(NotificationType.AdminQueueItem, {
      source: 'admin',
      queue: 'invite_requests',
      itemId: 'b2222222-2222-2222-2222-222222222222',
    });
    expect(first).toBe('admin_queue_item:invite_requests');
    expect(second).toBe(first);
  });

  it('keeps different queues apart', () => {
    expect(
      bundleKeyFor(NotificationType.AdminQueueItem, {
        queue: 'invite_requests',
      }),
    ).not.toBe(
      bundleKeyFor(NotificationType.AdminQueueItem, { queue: 'dsar' }),
    );
  });

  it('writes its own row when the queue field is missing', () => {
    expect(bundleKeyFor(NotificationType.AdminQueueItem, {})).toBeNull();
  });
});

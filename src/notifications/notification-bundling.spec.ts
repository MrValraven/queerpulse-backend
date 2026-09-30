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

describe('bundleKeyFor for persona feed imports', () => {
  it('collapses new-episode rows onto the persona, across its feeds', () => {
    const first = bundleKeyFor(NotificationType.PersonaImportReady, {
      subprofileId: 'sp-1',
      feedId: 'feed-a',
      newItemCount: 2,
    });
    const second = bundleKeyFor(NotificationType.PersonaImportReady, {
      subprofileId: 'sp-1',
      feedId: 'feed-b',
      newItemCount: 1,
    });
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(
      bundleKeyFor(NotificationType.PersonaImportReady, {
        subprofileId: 'sp-2',
      }),
    ).not.toBe(first);
  });
});

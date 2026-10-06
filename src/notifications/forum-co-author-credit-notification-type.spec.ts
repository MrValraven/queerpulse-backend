import { Notification, NotificationType } from './entities/notification.entity';
import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  categoryForType,
} from './notification-preferences';
import { actorIdOf, toClientPayload } from './notification-response';

function notificationRow(payload: Record<string, unknown>): Notification {
  return {
    id: 'notification-1',
    userId: 'bea-1',
    type: NotificationType.ForumCoAuthorCredit,
    payload,
    read: false,
    createdAt: new Date('2026-10-06T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

/** PRD-408: the notice a member gets when a thread credits them as co-author. */
describe('ForumCoAuthorCredit notification type', () => {
  it('stores the label the migration adds', () => {
    expect(NotificationType.ForumCoAuthorCredit).toBe('forum_co_author_credit');
  });

  it('is always delivered, with no member switch', () => {
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).toContain(
      NotificationType.ForumCoAuthorCredit,
    );
    expect(categoryForType(NotificationType.ForumCoAuthorCredit)).toBeNull();
  });

  it('forwards the thread link and title and drops everything else', () => {
    expect(
      toClientPayload(
        notificationRow({
          source: 'forum',
          threadSlug: 'a-guide',
          threadTitle: 'A guide',
          actorId: 'author-1',
          excerpt: 'member-authored text that must stay off the wire',
        }),
      ),
    ).toEqual({
      source: 'forum',
      threadSlug: 'a-guide',
      threadTitle: 'A guide',
    });
  });

  it('names the author as the actor when the payload carries one', () => {
    expect(
      actorIdOf(
        notificationRow({
          source: 'forum',
          threadSlug: 'a-guide',
          threadTitle: 'A guide',
          actorId: 'author-1',
        }),
      ),
    ).toBe('author-1');
  });

  it('names nobody for a masked byline', () => {
    expect(
      actorIdOf(
        notificationRow({
          source: 'forum',
          threadSlug: 'a-guide',
          threadTitle: 'A guide',
        }),
      ),
    ).toBeNull();
  });
});

import { Notification, NotificationType } from './entities/notification.entity';
import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  NotificationPreferenceCategory,
  categoryForType,
} from './notification-preferences';
import { toClientPayload } from './notification-response';

function notificationRow(
  type: NotificationType,
  payload: Record<string, unknown>,
): Notification {
  return {
    id: 'notification-1',
    userId: 'saver-1',
    type,
    payload,
    read: false,
    createdAt: new Date('2026-10-05T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

describe('Funding & Grants notification types', () => {
  it('stores the labels the migration adds', () => {
    expect(NotificationType.FundingDeadlineSoon).toBe('funding_deadline_soon');
    expect(NotificationType.FundingDeadlineChanged).toBe(
      'funding_deadline_changed',
    );
  });

  it('puts both behind the Opportunities switch', () => {
    expect(categoryForType(NotificationType.FundingDeadlineSoon)).toBe(
      NotificationPreferenceCategory.Opportunities,
    );
    expect(categoryForType(NotificationType.FundingDeadlineChanged)).toBe(
      NotificationPreferenceCategory.Opportunities,
    );
  });

  it('leaves both out of the always-delivered list', () => {
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).not.toContain(
      NotificationType.FundingDeadlineSoon,
    );
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).not.toContain(
      NotificationType.FundingDeadlineChanged,
    );
  });

  it('forwards the reminder copy fields and drops everything else', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.FundingDeadlineSoon, {
          source: 'forum',
          threadSlug: 'arts-grant',
          threadTitle: 'Arts grant',
          deadline: '2026-10-12T22:59:00.000Z',
          stage: '7d',
          excerpt: 'member-authored text that must stay off the wire',
          actorId: 'author-1',
        }),
      ),
    ).toEqual({
      source: 'forum',
      threadSlug: 'arts-grant',
      threadTitle: 'Arts grant',
      deadline: '2026-10-12T22:59:00.000Z',
      stage: '7d',
    });
  });

  it('forwards the moved-deadline copy fields', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.FundingDeadlineChanged, {
          source: 'forum',
          threadSlug: 'arts-grant',
          threadTitle: 'Arts grant',
          deadline: '2026-12-15T23:59:00.000Z',
          stage: '7d',
        }),
      ),
    ).toEqual({
      source: 'forum',
      threadSlug: 'arts-grant',
      threadTitle: 'Arts grant',
      deadline: '2026-12-15T23:59:00.000Z',
    });
  });
});

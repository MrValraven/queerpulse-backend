import { Notification, NotificationType } from './entities/notification.entity';
import {
  NotificationPreferenceCategory,
  categoryForType,
} from './notification-preferences';
import { ACTOR_PAYLOAD_KEY, toClientPayload } from './notification-response';

function notificationRow(
  type: NotificationType,
  payload: Record<string, unknown>,
): Notification {
  return {
    id: 'notification-1',
    userId: 'user-9',
    type,
    payload,
    read: false,
    createdAt: new Date('2026-11-24T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

/** The badge_earned payload a quiz badge win adds fields to. */
describe('Quiz badge notification payload', () => {
  it('forwards the quiz fields of a quiz badge win', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.BadgeEarned, {
          badgeKey: 'quiz:def-1',
          badgeName: 'Quiz Night Champion',
          badgeNamePt: 'Campeã da noite de quiz',
          eventName: 'Pride Quiz Night',
          userId: 'user-9',
        }),
      ),
    ).toEqual({
      badgeKey: 'quiz:def-1',
      badgeName: 'Quiz Night Champion',
      badgeNamePt: 'Campeã da noite de quiz',
      eventName: 'Pride Quiz Night',
    });
  });

  it('keeps a code badge payload as it was', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.BadgeEarned, {
          badgeKey: 'first-gathering',
          badgeName: 'First gathering',
        }),
      ),
    ).toEqual({ badgeKey: 'first-gathering', badgeName: 'First gathering' });
  });

  it('keeps badge_earned in the Recognition category with no actor', () => {
    expect(categoryForType(NotificationType.BadgeEarned)).toBe(
      NotificationPreferenceCategory.Recognition,
    );
    expect(ACTOR_PAYLOAD_KEY[NotificationType.BadgeEarned]).toBeUndefined();
  });
});

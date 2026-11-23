import { Notification, NotificationType } from './entities/notification.entity';
import { visibleThroughActorBlocks } from './notification-actor-block';
import { bundleKeyFor } from './notification-bundling';
import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  NotificationPreferenceCategory,
  categoryForType,
} from './notification-preferences';
import {
  ACTOR_PAYLOAD_KEY,
  actorIdOf,
  toClientPayload,
} from './notification-response';

const SENDER_ID = '7d1f3a52-8c64-4e09-b2a7-4f6e1c9d0b83';

function notificationRow(
  type: NotificationType,
  payload: Record<string, unknown>,
): Notification {
  return {
    id: 'notification-1',
    userId: 'member-1',
    type,
    payload,
    read: false,
    createdAt: new Date('2026-11-22T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

/** The two bell notices the community badges feature adds. */
describe('Community badge notification types', () => {
  it('stores the labels the migration adds', () => {
    expect(NotificationType.CommunityBadgeEarned).toBe(
      'community_badge_earned',
    );
    expect(NotificationType.CommunityGiftReceived).toBe(
      'community_gift_received',
    );
  });

  it('maps both types to Recognition and leaves them out of the always delivered list', () => {
    expect(categoryForType(NotificationType.CommunityBadgeEarned)).toBe(
      NotificationPreferenceCategory.Recognition,
    );
    expect(categoryForType(NotificationType.CommunityGiftReceived)).toBe(
      NotificationPreferenceCategory.Recognition,
    );
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).not.toContain(
      NotificationType.CommunityBadgeEarned,
    );
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).not.toContain(
      NotificationType.CommunityGiftReceived,
    );
  });

  it('resolves the gift sender as actor and gives the badge none', () => {
    expect(ACTOR_PAYLOAD_KEY[NotificationType.CommunityGiftReceived]).toBe(
      'senderId',
    );
    expect(
      ACTOR_PAYLOAD_KEY[NotificationType.CommunityBadgeEarned],
    ).toBeUndefined();
    expect(
      actorIdOf(
        notificationRow(NotificationType.CommunityGiftReceived, {
          senderId: SENDER_ID,
        }),
      ),
    ).toBe(SENDER_ID);
    expect(
      actorIdOf(
        notificationRow(NotificationType.CommunityBadgeEarned, {
          senderId: SENDER_ID,
        }),
      ),
    ).toBeNull();
  });

  it('forwards the badge fields including starterKey', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.CommunityBadgeEarned, {
          communitySlug: 'night-swim',
          communityName: 'Night swim',
          badgeId: 'badge-1',
          badgeName: 'Regular',
          starterKey: 'regular',
          iconKey: 'calendar',
          tint: 'jade',
          extra: 'x',
        }),
      ),
    ).toEqual({
      communitySlug: 'night-swim',
      communityName: 'Night swim',
      badgeId: 'badge-1',
      badgeName: 'Regular',
      starterKey: 'regular',
      iconKey: 'calendar',
      tint: 'jade',
    });
  });

  it('forwards the gift note and drops the raw sender id', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.CommunityGiftReceived, {
          communitySlug: 'night-swim',
          communityName: 'Night swim',
          giftId: 'gift-1',
          giftKey: 'heart',
          note: 'thank you for the door',
          senderId: SENDER_ID,
        }),
      ),
    ).toEqual({
      communitySlug: 'night-swim',
      communityName: 'Night swim',
      giftId: 'gift-1',
      giftKey: 'heart',
      note: 'thank you for the door',
    });
  });

  it('never bundles either type', () => {
    expect(
      bundleKeyFor(NotificationType.CommunityBadgeEarned, {
        communitySlug: 'night-swim',
        badgeId: 'badge-1',
      }),
    ).toBeNull();
    expect(
      bundleKeyFor(NotificationType.CommunityGiftReceived, {
        communitySlug: 'night-swim',
        giftId: 'gift-1',
        senderId: SENDER_ID,
      }),
    ).toBeNull();
  });

  it('builds an actor block arm for senderId', () => {
    const sql =
      visibleThroughActorBlocks('reader-1').getSql?.('Notification.id') ?? '';
    expect(sql).toMatch(
      /'community_gift_received'[^)]*\) THEN \(Notification\.payload\) ->> 'senderId'/,
    );
    expect(sql).not.toContain('community_badge_earned');
  });
});

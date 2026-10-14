import { Notification, NotificationType } from './entities/notification.entity';
import { bundleKeyFor } from './notification-bundling';
import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  NotificationPreferenceCategory,
  categoryForType,
} from './notification-preferences';
import { ACTOR_PAYLOAD_KEY, toClientPayload } from './notification-response';

const STORED_PAYLOAD = {
  subprofileName: 'Night Shift',
  subprofileSlugOrHandle: 'night-shift',
  subprofileId: 'persona-1',
  postId: 'post-1',
  excerpt: 'New single out Friday',
};

function notificationRow(payload: Record<string, unknown>): Notification {
  return {
    id: 'notification-1',
    userId: 'follower-1',
    type: NotificationType.PersonaPost,
    payload,
    read: false,
    createdAt: new Date('2026-10-13T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

describe('Persona post notification type', () => {
  it('stores the label the migration adds', () => {
    expect(NotificationType.PersonaPost).toBe('persona_post');
  });

  it('answers to the Personas you follow switch and can be turned off', () => {
    expect(categoryForType(NotificationType.PersonaPost)).toBe(
      NotificationPreferenceCategory.PersonaFollows,
    );
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).not.toContain(
      NotificationType.PersonaPost,
    );
  });

  it('bundles on the persona, so a run of updates is one row', () => {
    expect(bundleKeyFor(NotificationType.PersonaPost, STORED_PAYLOAD)).toBe(
      'persona_post:persona-1',
    );
  });

  it('names no actor, so the member behind the persona is never resolved', () => {
    expect(ACTOR_PAYLOAD_KEY[NotificationType.PersonaPost]).toBeUndefined();
  });

  it('forwards the persona, the post id and the excerpt and drops the persona id', () => {
    expect(
      toClientPayload(
        notificationRow({
          ...STORED_PAYLOAD,
          authorUserId: 'member-1',
          body: 'the whole body stays off the wire',
        }),
      ),
    ).toEqual({
      subprofileName: 'Night Shift',
      subprofileSlugOrHandle: 'night-shift',
      postId: 'post-1',
      excerpt: 'New single out Friday',
    });
  });
});

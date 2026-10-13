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
  releaseId: 'release-1',
  releaseTitle: 'Lisbon at four',
  releaseType: 'mix',
};

function notificationRow(payload: Record<string, unknown>): Notification {
  return {
    id: 'notification-1',
    userId: 'follower-1',
    type: NotificationType.StudioReleasePublished,
    payload,
    read: false,
    createdAt: new Date('2026-10-13T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

describe('Studio new-release notification type', () => {
  it('stores the label the migration adds', () => {
    expect(NotificationType.StudioReleasePublished).toBe(
      'studio_release_published',
    );
  });

  it('answers to the Personas you follow switch and can be turned off', () => {
    expect(categoryForType(NotificationType.StudioReleasePublished)).toBe(
      NotificationPreferenceCategory.PersonaFollows,
    );
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).not.toContain(
      NotificationType.StudioReleasePublished,
    );
  });

  it('bundles on the persona, so several releases in a day are one row', () => {
    expect(
      bundleKeyFor(NotificationType.StudioReleasePublished, STORED_PAYLOAD),
    ).toBe('studio_release_published:persona-1');
  });

  it('names no actor, so the persona owner is never resolved onto the bell', () => {
    expect(
      ACTOR_PAYLOAD_KEY[NotificationType.StudioReleasePublished],
    ).toBeUndefined();
  });

  it('forwards the release copy fields and drops the persona id and anything else', () => {
    expect(
      toClientPayload(
        notificationRow({
          ...STORED_PAYLOAD,
          ownerId: 'owner-1',
          description: 'member-authored text that stays off the wire',
        }),
      ),
    ).toEqual({
      subprofileName: 'Night Shift',
      subprofileSlugOrHandle: 'night-shift',
      releaseId: 'release-1',
      releaseTitle: 'Lisbon at four',
      releaseType: 'mix',
    });
  });
});

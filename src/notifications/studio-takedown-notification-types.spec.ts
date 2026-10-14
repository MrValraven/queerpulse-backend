import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Notification, NotificationType } from './entities/notification.entity';
import { bundleKeyFor } from './notification-bundling';
import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  categoryForType,
} from './notification-preferences';
import { ACTOR_PAYLOAD_KEY, toClientPayload } from './notification-response';

const STUDIO_NOTICE_TYPES = [
  NotificationType.StudioReleaseTakenDown,
  NotificationType.StudioReleaseDisputeDecided,
];

function notificationRow(
  type: NotificationType,
  payload: Record<string, unknown>,
): Notification {
  return {
    id: 'notification-1',
    userId: 'owner-1',
    type,
    payload,
    read: false,
    createdAt: new Date('2026-10-13T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

describe('Studio takedown notification types', () => {
  it('stores the labels the migration adds', () => {
    expect(NotificationType.StudioReleaseTakenDown).toBe(
      'studio_release_taken_down',
    );
    expect(NotificationType.StudioReleaseDisputeDecided).toBe(
      'studio_release_dispute_decided',
    );
  });

  it.each(STUDIO_NOTICE_TYPES)(
    'always delivers %s, behind no switch',
    (type) => {
      expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).toContain(type);
      expect(categoryForType(type)).toBeNull();
    },
  );

  it.each(STUDIO_NOTICE_TYPES)(
    'names no actor and bundles nothing for %s',
    (type) => {
      expect(ACTOR_PAYLOAD_KEY[type]).toBeUndefined();
      expect(bundleKeyFor(type, { releaseId: 'release-1' })).toBeNull();
    },
  );

  it('forwards the release id and title of a takedown and drops the reason', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioReleaseTakenDown, {
          releaseId: 'release-1',
          releaseTitle: 'Lisbon at four',
          reason: 'Uploaded without the rights',
          actorId: 'staff-1',
        }),
      ),
    ).toEqual({ releaseId: 'release-1', releaseTitle: 'Lisbon at four' });
  });

  it('forwards the outcome of a dispute decision and drops the staff reply', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioReleaseDisputeDecided, {
          releaseId: 'release-1',
          releaseTitle: 'Lisbon at four',
          outcome: 'upheld',
          staffReply: 'Thanks, the licence checks out',
        }),
      ),
    ).toEqual({
      releaseId: 'release-1',
      releaseTitle: 'Lisbon at four',
      outcome: 'upheld',
    });
  });

  // A lock screen naming the release would tell anyone nearby which artist
  // persona the member runs, so both stay in the bell.
  it('stays off the push whitelist', () => {
    const listenerSource = readFileSync(
      join(__dirname, '..', 'push', 'push-notification.listener.ts'),
      'utf8',
    );
    expect(listenerSource).not.toContain(
      'NotificationType.StudioReleaseTakenDown',
    );
    expect(listenerSource).not.toContain(
      'NotificationType.StudioReleaseDisputeDecided',
    );
  });
});

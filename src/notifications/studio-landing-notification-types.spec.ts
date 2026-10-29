import { AddStudioLandingNotificationTypes1838100100000 } from '../migrations/1838100100000-AddStudioLandingNotificationTypes';
import { Notification, NotificationType } from './entities/notification.entity';
import { bundleKeyFor } from './notification-bundling';
import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  NotificationPreferenceCategory,
  categoryForType,
} from './notification-preferences';
import { ACTOR_PAYLOAD_KEY, toClientPayload } from './notification-response';

const REQUESTED_PAYLOAD = {
  previewId: 'preview-1',
  subprofileId: 'persona-1',
  personaName: 'Night Shift',
  trackTitle: 'Opening',
};

const LIVE_PAYLOAD = {
  previewId: 'preview-1',
  subprofileId: 'persona-2',
  mainPersonaName: 'Night Shift',
  trackTitle: 'Opening',
};

function notificationRow(
  type: NotificationType,
  payload: Record<string, unknown>,
): Notification {
  return {
    id: 'notification-1',
    userId: 'recipient-1',
    type,
    payload,
    read: false,
    createdAt: new Date('2026-10-28T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

describe('Studio landing notification types', () => {
  it('stores the labels the migration adds', () => {
    expect(NotificationType.StudioAccessGranted).toBe('studio_access_granted');
    expect(NotificationType.StudioLandingPreviewRequested).toBe(
      'studio_landing_preview_requested',
    );
    expect(NotificationType.StudioLandingPreviewLive).toBe(
      'studio_landing_preview_live',
    );
  });

  it('delivers the grant notice always and the two landing notices behind Personas', () => {
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).toContain(
      NotificationType.StudioAccessGranted,
    );
    expect([
      categoryForType(NotificationType.StudioLandingPreviewRequested),
      categoryForType(NotificationType.StudioLandingPreviewLive),
    ]).toEqual([
      NotificationPreferenceCategory.Personas,
      NotificationPreferenceCategory.Personas,
    ]);
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).not.toContain(
      NotificationType.StudioLandingPreviewRequested,
    );
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).not.toContain(
      NotificationType.StudioLandingPreviewLive,
    );
  });

  it('keeps the preview id and every member off the wire', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioLandingPreviewRequested, {
          ...REQUESTED_PAYLOAD,
          approverUserId: 'member-1',
        }),
      ),
    ).toEqual({
      subprofileId: 'persona-1',
      personaName: 'Night Shift',
      trackTitle: 'Opening',
    });
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioLandingPreviewLive, {
          ...LIVE_PAYLOAD,
          approverUserId: 'member-2',
        }),
      ),
    ).toEqual({
      subprofileId: 'persona-2',
      mainPersonaName: 'Night Shift',
      trackTitle: 'Opening',
    });
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioAccessGranted, {}),
      ),
    ).toEqual({});
  });

  it('names no actor for the three types', () => {
    expect([
      ACTOR_PAYLOAD_KEY[NotificationType.StudioAccessGranted],
      ACTOR_PAYLOAD_KEY[NotificationType.StudioLandingPreviewRequested],
      ACTOR_PAYLOAD_KEY[NotificationType.StudioLandingPreviewLive],
    ]).toEqual([undefined, undefined, undefined]);
  });

  it('bundles both landing notices on the persona and leaves the grant notice alone', () => {
    expect([
      bundleKeyFor(
        NotificationType.StudioLandingPreviewRequested,
        REQUESTED_PAYLOAD,
      ),
      bundleKeyFor(NotificationType.StudioLandingPreviewLive, LIVE_PAYLOAD),
      bundleKeyFor(NotificationType.StudioAccessGranted, {}),
    ]).toEqual([
      'studio_landing_preview_requested:persona-1',
      'studio_landing_preview_live:persona-2',
      null,
    ]);
  });

  it('adds the three labels in the contract order, outside a transaction', async () => {
    const migration = new AddStudioLandingNotificationTypes1838100100000();
    expect(migration.transaction).toBe(false);

    const statements: string[] = [];
    const queryRunner = {
      query: (statement: string): Promise<void> => {
        statements.push(statement);
        return Promise.resolve();
      },
    };
    await migration.up(queryRunner as never);

    expect(statements).toEqual([
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_access_granted'`,
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_landing_preview_requested'`,
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_landing_preview_live'`,
    ]);
  });

  it('refuses to roll back', async () => {
    await expect(
      new AddStudioLandingNotificationTypes1838100100000().down(),
    ).rejects.toThrow('Irreversible');
  });
});

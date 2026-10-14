import { Notification, NotificationType } from './entities/notification.entity';
import { bundleKeyFor } from './notification-bundling';
import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  NotificationPreferenceCategory,
  categoryForType,
} from './notification-preferences';
import { ACTOR_PAYLOAD_KEY, toClientPayload } from './notification-response';

const STORED_PAYLOAD = {
  subprofileName: 'Lisbon After Dark',
  subprofileSlugOrHandle: 'lisbon-after-dark',
  subprofileId: 'persona-1',
  releaseId: 'show-1',
  trackId: 'episode-1',
  releaseTitle: 'Lisbon After Dark',
  trackTitle: 'Housing in Lisbon',
};

function notificationRow(payload: Record<string, unknown>): Notification {
  return {
    id: 'notification-1',
    userId: 'follower-1',
    type: NotificationType.StudioEpisodePublished,
    payload,
    read: false,
    createdAt: new Date('2026-10-14T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

describe('Studio episode notification type', () => {
  it('stores the label the migration adds', () => {
    expect(NotificationType.StudioEpisodePublished).toBe(
      'studio_episode_published',
    );
  });

  it('answers to the Personas you follow switch and can be turned off', () => {
    expect(categoryForType(NotificationType.StudioEpisodePublished)).toBe(
      NotificationPreferenceCategory.PersonaFollows,
    );
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).not.toContain(
      NotificationType.StudioEpisodePublished,
    );
  });

  it('bundles on the show, so a run of episodes is one row', () => {
    expect(
      bundleKeyFor(NotificationType.StudioEpisodePublished, STORED_PAYLOAD),
    ).toBe('studio_episode_published:show-1');
  });

  it('names no actor, so the member behind the persona is never resolved', () => {
    expect(
      ACTOR_PAYLOAD_KEY[NotificationType.StudioEpisodePublished],
    ).toBeUndefined();
  });

  it('forwards the show, the episode and the persona and drops the persona id', () => {
    expect(
      toClientPayload(
        notificationRow({ ...STORED_PAYLOAD, ownerUserId: 'member-1' }),
      ),
    ).toEqual({
      subprofileName: 'Lisbon After Dark',
      subprofileSlugOrHandle: 'lisbon-after-dark',
      releaseId: 'show-1',
      trackId: 'episode-1',
      releaseTitle: 'Lisbon After Dark',
      trackTitle: 'Housing in Lisbon',
    });
  });
});

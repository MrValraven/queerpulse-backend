import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Notification, NotificationType } from './entities/notification.entity';
import { bundleKeyFor } from './notification-bundling';
import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  STUDIO_SAFETY_NOTICE_TYPES,
  categoryForType,
} from './notification-preferences';
import { ACTOR_PAYLOAD_KEY, toClientPayload } from './notification-response';

const CLAIM_ID = 'c7000000-0000-4000-8000-000000000001';
const TRACK_ID = 'c7100000-0000-4000-8000-000000000001';
const RELEASE_ID = 'c7200000-0000-4000-8000-000000000001';

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
    createdAt: new Date('2026-10-14T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

describe('Studio safety notification types', () => {
  it('stores the labels the migration adds', () => {
    expect(STUDIO_SAFETY_NOTICE_TYPES).toEqual([
      'studio_copyright_claim_accepted',
      'studio_copyright_claim_declined',
      'studio_copyright_claim_countered',
      'studio_copyright_claim_decided',
      'studio_copyright_claim_withdrawn',
      'studio_track_marked',
    ]);
  });

  it.each(STUDIO_SAFETY_NOTICE_TYPES)(
    'always delivers %s, behind no switch',
    (type) => {
      expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).toContain(type);
      expect(categoryForType(type)).toBeNull();
    },
  );

  it.each(STUDIO_SAFETY_NOTICE_TYPES)(
    'names no actor and bundles nothing for %s',
    (type) => {
      expect(ACTOR_PAYLOAD_KEY[type]).toBeUndefined();
      expect(
        bundleKeyFor(type, { claimId: CLAIM_ID, trackId: TRACK_ID }),
      ).toBeNull();
    },
  );

  it('forwards the owner fields of an accepted claim and nothing else', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioCopyrightClaimAccepted, {
          claimId: CLAIM_ID,
          trackId: TRACK_ID,
          releaseId: RELEASE_ID,
          trackTitle: 'Opening',
          claimantId: 'claimant-1',
          actorId: 'staff-1',
          staffNote: 'Licence missing',
        }),
      ),
    ).toEqual({
      claimId: CLAIM_ID,
      trackId: TRACK_ID,
      releaseId: RELEASE_ID,
      trackTitle: 'Opening',
    });
  });

  it.each([
    NotificationType.StudioCopyrightClaimDeclined,
    NotificationType.StudioCopyrightClaimCountered,
  ])('gives the claimant the claim and the title only on %s', (type) => {
    expect(
      toClientPayload(
        notificationRow(type, {
          claimId: CLAIM_ID,
          trackTitle: 'Opening',
          trackId: TRACK_ID,
          releaseId: RELEASE_ID,
          counterNote: 'I wrote every bar',
        }),
      ),
    ).toEqual({ claimId: CLAIM_ID, trackTitle: 'Opening' });
  });

  it('gives an owner decided row its track and release', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioCopyrightClaimDecided, {
          claimId: CLAIM_ID,
          trackId: TRACK_ID,
          releaseId: RELEASE_ID,
          trackTitle: 'Opening',
          outcome: 'rejected',
          recipientRole: 'owner',
        }),
      ),
    ).toEqual({
      claimId: CLAIM_ID,
      trackId: TRACK_ID,
      releaseId: RELEASE_ID,
      trackTitle: 'Opening',
      outcome: 'rejected',
      recipientRole: 'owner',
    });
  });

  it('keeps the track and release ids off a claimant decided row, even when stored', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioCopyrightClaimDecided, {
          claimId: CLAIM_ID,
          trackId: TRACK_ID,
          releaseId: RELEASE_ID,
          trackTitle: 'Opening',
          outcome: 'upheld',
          recipientRole: 'claimant',
        }),
      ),
    ).toEqual({
      claimId: CLAIM_ID,
      trackTitle: 'Opening',
      outcome: 'upheld',
      recipientRole: 'claimant',
    });
  });

  it('forwards a withdrawn claim and a marked track to owners', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioCopyrightClaimWithdrawn, {
          claimId: CLAIM_ID,
          trackId: TRACK_ID,
          releaseId: RELEASE_ID,
          trackTitle: 'Opening',
        }),
      ),
    ).toEqual({
      claimId: CLAIM_ID,
      trackId: TRACK_ID,
      releaseId: RELEASE_ID,
      trackTitle: 'Opening',
    });
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioTrackMarked, {
          trackId: TRACK_ID,
          releaseId: RELEASE_ID,
          trackTitle: 'Opening',
          change: 'content_warning',
          warnings: ['police'],
        }),
      ),
    ).toEqual({
      trackId: TRACK_ID,
      releaseId: RELEASE_ID,
      trackTitle: 'Opening',
      change: 'content_warning',
    });
  });

  // In-app only (coordinator ruling): a lock screen naming a track would tie
  // the member to the persona, or to the claim they filed.
  it('stays off the push whitelist', () => {
    const listenerSource = readFileSync(
      join(__dirname, '..', 'push', 'push-notification.listener.ts'),
      'utf8',
    );
    for (const memberName of [
      'StudioCopyrightClaimAccepted',
      'StudioCopyrightClaimDeclined',
      'StudioCopyrightClaimCountered',
      'StudioCopyrightClaimDecided',
      'StudioCopyrightClaimWithdrawn',
      'StudioTrackMarked',
    ]) {
      expect(listenerSource).not.toContain(`NotificationType.${memberName}`);
    }
  });
});

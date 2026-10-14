import { Notification, NotificationType } from './entities/notification.entity';
import { bundleKeyFor } from './notification-bundling';
import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  NotificationPreferenceCategory,
  categoryForType,
} from './notification-preferences';
import { ACTOR_PAYLOAD_KEY, toClientPayload } from './notification-response';

const REQUESTED_PAYLOAD = {
  creditId: 'credit-1',
  creditedSubprofileId: 'persona-credited',
  creditedPersonaName: 'River Ink',
  creditedPersonaHandle: 'river-ink',
  requestingPersonaName: 'Night Shift',
  requestingPersonaHandle: 'night-shift',
  trackId: 'track-1',
  trackTitle: 'Opening',
  releaseId: 'release-1',
  releaseTitle: 'Lisbon at four',
  role: 'cover-art',
};

const ACCEPTED_PAYLOAD = {
  creditId: 'credit-1',
  requestingSubprofileId: 'persona-requesting',
  requestingPersonaName: 'Night Shift',
  creditedPersonaName: 'River Ink',
  creditedPersonaHandle: 'river-ink',
  trackId: 'track-1',
  trackTitle: 'Opening',
  releaseId: 'release-1',
  releaseTitle: 'Lisbon at four',
  role: 'cover-art',
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
    createdAt: new Date('2026-10-13T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

describe('Studio credit notification types', () => {
  it('stores the labels the migration adds', () => {
    expect(NotificationType.StudioCreditRequested).toBe(
      'studio_credit_requested',
    );
    expect(NotificationType.StudioCreditAccepted).toBe(
      'studio_credit_accepted',
    );
  });

  it.each([
    NotificationType.StudioCreditRequested,
    NotificationType.StudioCreditAccepted,
  ])('puts %s behind the Personas switch, beside persona invites', (type) => {
    expect(categoryForType(type)).toBe(NotificationPreferenceCategory.Personas);
    expect(categoryForType(type)).toBe(
      categoryForType(NotificationType.SubprofileInvite),
    );
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).not.toContain(type);
  });

  it('bundles a request on the credited persona and an acceptance on the track', () => {
    expect(
      bundleKeyFor(NotificationType.StudioCreditRequested, REQUESTED_PAYLOAD),
    ).toBe('studio_credit_requested:persona-credited');
    expect(
      bundleKeyFor(NotificationType.StudioCreditAccepted, ACCEPTED_PAYLOAD),
    ).toBe('studio_credit_accepted:track-1');
  });

  it('names no actor for either type, so no member is resolved onto the bell', () => {
    expect(
      ACTOR_PAYLOAD_KEY[NotificationType.StudioCreditRequested],
    ).toBeUndefined();
    expect(
      ACTOR_PAYLOAD_KEY[NotificationType.StudioCreditAccepted],
    ).toBeUndefined();
  });

  it('sends a request with persona names, titles and the role, and drops every id and member field', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioCreditRequested, {
          ...REQUESTED_PAYLOAD,
          requestedByUserId: 'member-1',
        }),
      ),
    ).toEqual({
      creditedPersonaName: 'River Ink',
      requestingPersonaName: 'Night Shift',
      requestingPersonaHandle: 'night-shift',
      trackTitle: 'Opening',
      releaseTitle: 'Lisbon at four',
      role: 'cover-art',
    });
  });

  it('sends an acceptance with the track id for its link, and drops the other ids', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioCreditAccepted, {
          ...ACCEPTED_PAYLOAD,
          acceptedByUserId: 'member-2',
        }),
      ),
    ).toEqual({
      requestingPersonaName: 'Night Shift',
      creditedPersonaName: 'River Ink',
      creditedPersonaHandle: 'river-ink',
      trackId: 'track-1',
      trackTitle: 'Opening',
      releaseTitle: 'Lisbon at four',
      role: 'cover-art',
    });
  });
});

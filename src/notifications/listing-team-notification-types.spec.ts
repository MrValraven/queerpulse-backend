import { Notification, NotificationType } from './entities/notification.entity';
import { bundleKeyFor } from './notification-bundling';
import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  NotificationPreferenceCategory,
  categoryForType,
} from './notification-preferences';
import { ACTOR_PAYLOAD_KEY, toClientPayload } from './notification-response';

const INVITE_PAYLOAD = {
  subprofileId: 'persona-1',
  personaName: 'River Ink',
  listingName: 'Ink House',
  listingSlug: 'ink-house',
  roleLabel: 'Tattoo artist',
};

const REQUEST_PAYLOAD = {
  listingRef: 'QPL-2026-0042',
  listingName: 'Ink House',
  personaName: 'River Ink',
  personaHandle: 'river-ink',
};

const ACCEPTED_LISTING_PAYLOAD = {
  initiatedBy: 'listing',
  listingName: 'Ink House',
  listingSlug: 'ink-house',
  personaName: 'River Ink',
  personaHandle: 'river-ink',
  listingRef: 'QPL-2026-0042',
};

const ACCEPTED_PERSONA_PAYLOAD = {
  initiatedBy: 'persona',
  listingName: 'Ink House',
  listingSlug: 'ink-house',
  personaName: 'River Ink',
  personaHandle: 'river-ink',
  subprofileId: 'persona-1',
};

const MEMBER_FIELDS = {
  requestedByUserId: 'member-1',
  actorId: 'member-1',
  ownerName: 'Ana Silva',
};

const TEAM_TYPES = [
  NotificationType.ListingTeamInvite,
  NotificationType.ListingTeamRequest,
  NotificationType.ListingTeamAccepted,
];

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
    createdAt: new Date('2026-10-19T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

describe('Listing team notification types', () => {
  it('stores the labels the migration adds', () => {
    expect(NotificationType.ListingTeamInvite).toBe('listing_team_invite');
    expect(NotificationType.ListingTeamRequest).toBe('listing_team_request');
    expect(NotificationType.ListingTeamAccepted).toBe('listing_team_accepted');
  });

  it('puts an invite behind Personas and a request and an acceptance behind Listings', () => {
    expect(categoryForType(NotificationType.ListingTeamInvite)).toBe(
      NotificationPreferenceCategory.Personas,
    );
    expect(categoryForType(NotificationType.ListingTeamRequest)).toBe(
      NotificationPreferenceCategory.Listings,
    );
    expect(categoryForType(NotificationType.ListingTeamAccepted)).toBe(
      NotificationPreferenceCategory.Listings,
    );
    for (const type of TEAM_TYPES) {
      expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).not.toContain(type);
    }
  });

  it('bundles none of the three', () => {
    expect(
      bundleKeyFor(NotificationType.ListingTeamInvite, INVITE_PAYLOAD),
    ).toBeNull();
    expect(
      bundleKeyFor(NotificationType.ListingTeamRequest, REQUEST_PAYLOAD),
    ).toBeNull();
    expect(
      bundleKeyFor(
        NotificationType.ListingTeamAccepted,
        ACCEPTED_LISTING_PAYLOAD,
      ),
    ).toBeNull();
    expect(
      bundleKeyFor(
        NotificationType.ListingTeamAccepted,
        ACCEPTED_PERSONA_PAYLOAD,
      ),
    ).toBeNull();
  });

  it('drops a stored member id from every team payload and names no actor', () => {
    for (const type of TEAM_TYPES) {
      expect(ACTOR_PAYLOAD_KEY[type]).toBeUndefined();
    }
    const cases: Array<[NotificationType, Record<string, unknown>]> = [
      [NotificationType.ListingTeamInvite, INVITE_PAYLOAD],
      [NotificationType.ListingTeamRequest, REQUEST_PAYLOAD],
      [NotificationType.ListingTeamAccepted, ACCEPTED_LISTING_PAYLOAD],
      [NotificationType.ListingTeamAccepted, ACCEPTED_PERSONA_PAYLOAD],
    ];
    for (const [type, payload] of cases) {
      expect(
        toClientPayload(
          notificationRow(type, { ...payload, ...MEMBER_FIELDS }),
        ),
      ).toEqual(payload);
    }
  });
});

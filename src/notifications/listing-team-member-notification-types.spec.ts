import { Notification, NotificationType } from './entities/notification.entity';
import { bundleKeyFor } from './notification-bundling';
import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  NotificationPreferenceCategory,
  categoryForType,
} from './notification-preferences';
import { ACTOR_PAYLOAD_KEY, toClientPayload } from './notification-response';

const INVITE_PAYLOAD = {
  listingName: 'Ink House',
  listingSlug: 'ink-house',
  roleLabel: 'Tattoo artist',
};

const ACCEPTED_PAYLOAD = {
  listingRef: 'QPL-2026-0042',
  listingName: 'Ink House',
  listingSlug: 'ink-house',
  memberName: 'Ana Silva',
  memberSlug: 'ana-silva',
};

const STORED_IDENTITY_FIELDS = {
  actingUserId: 'manager-1',
  actorId: 'manager-1',
  memberUserId: 'member-1',
  userId: 'member-1',
};

const MEMBER_TEAM_TYPES = [
  NotificationType.ListingTeamMemberInvite,
  NotificationType.ListingTeamMemberAccepted,
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
    createdAt: new Date('2026-10-30T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

describe('Listing team member notification types', () => {
  it('stores the labels the migration adds', () => {
    expect(NotificationType.ListingTeamMemberInvite).toBe(
      'listing_team_member_invite',
    );
    expect(NotificationType.ListingTeamMemberAccepted).toBe(
      'listing_team_member_accepted',
    );
  });

  it('puts both behind Listings and out of the always-delivered list', () => {
    for (const type of MEMBER_TEAM_TYPES) {
      expect(categoryForType(type)).toBe(
        NotificationPreferenceCategory.Listings,
      );
      expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).not.toContain(type);
    }
  });

  it('bundles neither', () => {
    expect(
      bundleKeyFor(NotificationType.ListingTeamMemberInvite, INVITE_PAYLOAD),
    ).toBeNull();
    expect(
      bundleKeyFor(
        NotificationType.ListingTeamMemberAccepted,
        ACCEPTED_PAYLOAD,
      ),
    ).toBeNull();
  });

  it('names no actor', () => {
    for (const type of MEMBER_TEAM_TYPES) {
      expect(ACTOR_PAYLOAD_KEY[type]).toBeUndefined();
    }
  });

  it('serves exactly the allowlisted keys and drops every stored user id', () => {
    const cases: Array<[NotificationType, Record<string, unknown>]> = [
      [NotificationType.ListingTeamMemberInvite, INVITE_PAYLOAD],
      [NotificationType.ListingTeamMemberAccepted, ACCEPTED_PAYLOAD],
    ];
    for (const [type, payload] of cases) {
      const clientPayload = toClientPayload(
        notificationRow(type, { ...payload, ...STORED_IDENTITY_FIELDS }),
      );
      expect(clientPayload).toEqual(payload);
      expect(Object.keys(clientPayload).sort()).toEqual(
        Object.keys(payload).sort(),
      );
    }
  });
});

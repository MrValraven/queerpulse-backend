import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { LISTING_TEAM_LISTING_RECIPIENTS_SQL } from './listing-team-alerts.listener';
import {
  LISTING_TEAM_MEMBER_ALERT_SQL,
  LISTING_TEAM_MEMBER_HIDDEN_FROM_SQL,
  ListingTeamMemberAlertsListener,
} from './listing-team-member-alerts.listener';

const MEMBER_ID = 'a9000000-0000-4000-8000-000000000002';
const MANAGER_USER = 'manager-1';
const MEMBER_USER = 'member-user-1';
const LISTING_USERS = ['listing-owner-1', 'listing-manager-1'];
const KNOWN_USER_IDS = [MANAGER_USER, MEMBER_USER, ...LISTING_USERS];

const ALLOWLIST: Record<string, string[]> = {
  [NotificationType.ListingTeamMemberInvite]: [
    'listingName',
    'listingSlug',
    'roleLabel',
  ],
  [NotificationType.ListingTeamMemberAccepted]: [
    'listingRef',
    'listingName',
    'listingSlug',
    'memberName',
    'memberSlug',
  ],
};

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMBER_ID,
    member_user_id: MEMBER_USER,
    role_label: 'Tattoo artist',
    listing_id: 'listing-1',
    listing_ref: 'LX-1',
    listing_slug: 'lux-cafe',
    listing_name: 'Lux Cafe',
    member_slug: 'ana-silva',
    member_first_name: 'Ana',
    member_last_name: 'Silva ',
    ...overrides,
  };
}

describe('ListingTeamMemberAlertsListener', () => {
  let query: jest.Mock;
  let notifications: { createForRecipients: jest.Mock };
  let listener: ListingTeamMemberAlertsListener;
  let teamRows: unknown[];
  let listingRecipients: string[];
  let hiddenFromUserIds: string[];

  beforeEach(() => {
    teamRows = [memberRow()];
    listingRecipients = LISTING_USERS;
    hiddenFromUserIds = [];
    query = jest.fn((sql: string) => {
      if (sql === LISTING_TEAM_MEMBER_ALERT_SQL) {
        return Promise.resolve(teamRows);
      }
      if (sql === LISTING_TEAM_MEMBER_HIDDEN_FROM_SQL) {
        return Promise.resolve(
          hiddenFromUserIds.map((userId) => ({ hidden_from_user_id: userId })),
        );
      }
      return Promise.resolve(
        listingRecipients.map((userId) => ({ user_id: userId })),
      );
    });
    notifications = { createForRecipients: jest.fn().mockResolvedValue([]) };
    listener = new ListingTeamMemberAlertsListener(
      { query } as unknown as DataSource,
      notifications as unknown as NotificationsService,
    );
  });

  const invitedEvent = { memberId: MEMBER_ID, actingUserId: MANAGER_USER };
  const acceptedEvent = { memberId: MEMBER_ID, actingUserId: MEMBER_USER };

  it('sends an invite to the invited member alone, with the acting manager for filtering only', async () => {
    await listener.handleInvited(invitedEvent);

    expect(query).toHaveBeenCalledWith(LISTING_TEAM_MEMBER_ALERT_SQL, [
      MEMBER_ID,
      'pending',
    ]);
    expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      [MEMBER_USER],
      NotificationType.ListingTeamMemberInvite,
      {
        listingName: 'Lux Cafe',
        listingSlug: 'lux-cafe',
        roleLabel: 'Tattoo artist',
      },
      MANAGER_USER,
    );
  });

  it('sends a null role label when the invite has none', async () => {
    teamRows = [memberRow({ role_label: null })];

    await listener.handleInvited(invitedEvent);

    const [, , payload] = notifications.createForRecipients.mock.calls[0] as [
      string[],
      unknown,
      Record<string, unknown>,
    ];
    expect(payload).toHaveProperty('roleLabel', null);
  });

  it('sends an acceptance to the owner and active co-managers, never the accepting member', async () => {
    listingRecipients = [...LISTING_USERS, MEMBER_USER];

    await listener.handleAccepted(acceptedEvent);

    expect(query).toHaveBeenCalledWith(LISTING_TEAM_MEMBER_ALERT_SQL, [
      MEMBER_ID,
      'accepted',
    ]);
    expect(query).toHaveBeenCalledWith(LISTING_TEAM_LISTING_RECIPIENTS_SQL, [
      'listing-1',
      MEMBER_USER,
    ]);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      LISTING_USERS,
      NotificationType.ListingTeamMemberAccepted,
      {
        listingRef: 'LX-1',
        listingName: 'Lux Cafe',
        listingSlug: 'lux-cafe',
        memberName: 'Ana Silva',
        memberSlug: 'ana-silva',
      },
      MEMBER_USER,
    );
  });

  it('leaves out a recipient the accepting member hid their profile from', async () => {
    hiddenFromUserIds = ['listing-manager-1'];

    await listener.handleAccepted(acceptedEvent);

    expect(query).toHaveBeenCalledWith(LISTING_TEAM_MEMBER_HIDDEN_FROM_SQL, [
      MEMBER_USER,
      LISTING_USERS,
    ]);
    expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
    const [recipients] = notifications.createForRecipients.mock.calls[0] as [
      string[],
    ];
    expect(recipients).toEqual(['listing-owner-1']);
  });

  it('sends no acceptance when the member hid their profile from every manager', async () => {
    hiddenFromUserIds = [...LISTING_USERS];

    await listener.handleAccepted(acceptedEvent);

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('stores the allowlisted keys alone and leaves every user id out of the payload', async () => {
    await listener.handleInvited(invitedEvent);
    await listener.handleAccepted(acceptedEvent);

    expect(notifications.createForRecipients).toHaveBeenCalledTimes(2);
    for (const call of notifications.createForRecipients.mock.calls as [
      string[],
      NotificationType,
      Record<string, unknown>,
      string,
    ][]) {
      const [, type, payload] = call;
      const allowedKeys = ALLOWLIST[type] ?? [];
      for (const key of Object.keys(payload)) {
        expect(allowedKeys).toContain(key);
      }
      for (const value of Object.values(payload)) {
        expect(KNOWN_USER_IDS).not.toContain(value);
      }
    }
  });

  it('never notifies the acting user', async () => {
    await listener.handleInvited(invitedEvent);
    await listener.handleAccepted(acceptedEvent);

    const [inviteRecipients] = notifications.createForRecipients.mock
      .calls[0] as [string[]];
    const [acceptedRecipients] = notifications.createForRecipients.mock
      .calls[1] as [string[]];
    expect(inviteRecipients).not.toContain(MANAGER_USER);
    expect(acceptedRecipients).not.toContain(MEMBER_USER);
  });

  it('sends nothing when the row no longer holds the status', async () => {
    teamRows = [];

    await listener.handleInvited(invitedEvent);
    await listener.handleAccepted(acceptedEvent);

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('sends no acceptance when the member has no slug or name', async () => {
    teamRows = [memberRow({ member_slug: null })];
    await listener.handleAccepted(acceptedEvent);

    teamRows = [memberRow({ member_first_name: ' ', member_last_name: null })];
    await listener.handleAccepted(acceptedEvent);

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('sends no acceptance when the listing has no one left to tell', async () => {
    listingRecipients = [];

    await listener.handleAccepted(acceptedEvent);

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('swallows a failure and logs the member row id alone', async () => {
    notifications.createForRecipients.mockRejectedValue(new Error('down'));
    const warn = jest
      .spyOn(
        (listener as unknown as { logger: { warn: (message: string) => void } })
          .logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await expect(listener.handleInvited(invitedEvent)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain(MEMBER_ID);
    for (const userId of KNOWN_USER_IDS) {
      expect(line).not.toContain(userId);
    }
  });
});

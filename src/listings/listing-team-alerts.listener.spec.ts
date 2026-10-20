import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  LISTING_TEAM_ALERT_SQL,
  LISTING_TEAM_LISTING_RECIPIENTS_SQL,
  LISTING_TEAM_PERSONA_RECIPIENTS_SQL,
  ListingTeamAlertsListener,
} from './listing-team-alerts.listener';

const MEMBER_ID = 'a9000000-0000-4000-8000-000000000001';
const ACTING_USER = 'acting-1';
const PERSONA_USERS = ['co-owner-1', 'owner-1'];
const LISTING_USERS = ['listing-owner-1', 'listing-manager-1'];
const KNOWN_USER_IDS = [ACTING_USER, ...PERSONA_USERS, ...LISTING_USERS];

const ALLOWLIST: Record<string, string[]> = {
  [NotificationType.ListingTeamInvite]: [
    'subprofileId',
    'personaName',
    'listingName',
    'listingSlug',
    'roleLabel',
  ],
  [NotificationType.ListingTeamRequest]: [
    'listingRef',
    'listingName',
    'personaName',
    'personaHandle',
  ],
  [NotificationType.ListingTeamAccepted]: [
    'initiatedBy',
    'listingName',
    'listingSlug',
    'personaName',
    'personaHandle',
    'listingRef',
    'subprofileId',
  ],
};

function teamRow(initiatedBy: 'listing' | 'persona') {
  return {
    id: MEMBER_ID,
    initiated_by: initiatedBy,
    role_label: null,
    listing_id: 'listing-1',
    listing_ref: 'LX-1',
    listing_slug: 'lux-cafe',
    listing_name: 'Lux Cafe',
    subprofile_id: 'persona-1',
    persona_handle: 'river-ink',
    persona_name: 'River Ink',
  };
}

describe('ListingTeamAlertsListener', () => {
  let query: jest.Mock;
  let notifications: { createForRecipients: jest.Mock };
  let listener: ListingTeamAlertsListener;
  let teamRows: unknown[];
  let listingRecipients: string[];

  beforeEach(() => {
    teamRows = [teamRow('listing')];
    listingRecipients = LISTING_USERS;
    query = jest.fn((sql: string) => {
      if (sql === LISTING_TEAM_ALERT_SQL) {
        return Promise.resolve(teamRows);
      }
      const userIds =
        sql === LISTING_TEAM_PERSONA_RECIPIENTS_SQL
          ? PERSONA_USERS
          : listingRecipients;
      return Promise.resolve(userIds.map((userId) => ({ user_id: userId })));
    });
    notifications = { createForRecipients: jest.fn().mockResolvedValue([]) };
    listener = new ListingTeamAlertsListener(
      { query } as unknown as DataSource,
      notifications as unknown as NotificationsService,
    );
  });

  const event = { memberId: MEMBER_ID, actingUserId: ACTING_USER };

  it("sends an invite to the persona's owners with the persona and listing names", async () => {
    await listener.handleInvited(event);

    expect(query).toHaveBeenCalledWith(LISTING_TEAM_ALERT_SQL, [
      MEMBER_ID,
      'pending',
    ]);
    expect(query).toHaveBeenCalledWith(LISTING_TEAM_PERSONA_RECIPIENTS_SQL, [
      'persona-1',
      ACTING_USER,
    ]);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['co-owner-1', 'owner-1'],
      NotificationType.ListingTeamInvite,
      {
        subprofileId: 'persona-1',
        personaName: 'River Ink',
        listingName: 'Lux Cafe',
        listingSlug: 'lux-cafe',
        roleLabel: null,
      },
      ACTING_USER,
    );
  });

  it('sends a request to the owner and active co-managers', async () => {
    await listener.handleRequested(event);

    expect(query).toHaveBeenCalledWith(LISTING_TEAM_LISTING_RECIPIENTS_SQL, [
      'listing-1',
      ACTING_USER,
    ]);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      LISTING_USERS,
      NotificationType.ListingTeamRequest,
      {
        listingRef: 'LX-1',
        listingName: 'Lux Cafe',
        personaName: 'River Ink',
        personaHandle: 'river-ink',
      },
      ACTING_USER,
    );
  });

  it('sends an acceptance to the starting side with its own link id', async () => {
    await listener.handleAccepted(event);
    const [listingRecipientIds, , listingPayload] = notifications
      .createForRecipients.mock.calls[0] as [
      string[],
      unknown,
      Record<string, unknown>,
    ];
    expect(query).toHaveBeenCalledWith(LISTING_TEAM_ALERT_SQL, [
      MEMBER_ID,
      'accepted',
    ]);
    expect(listingRecipientIds).toEqual(LISTING_USERS);
    expect(listingPayload).toHaveProperty('listingRef', 'LX-1');
    expect(listingPayload).not.toHaveProperty('subprofileId');
    expect(listingPayload).toHaveProperty('initiatedBy', 'listing');

    notifications.createForRecipients.mockClear();
    teamRows = [teamRow('persona')];
    await listener.handleAccepted(event);
    const [personaRecipientIds, type, personaPayload] = notifications
      .createForRecipients.mock.calls[0] as [
      string[],
      NotificationType,
      Record<string, unknown>,
    ];
    expect(personaRecipientIds).toEqual(PERSONA_USERS);
    expect(type).toBe(NotificationType.ListingTeamAccepted);
    expect(personaPayload).toHaveProperty('subprofileId', 'persona-1');
    expect(personaPayload).not.toHaveProperty('listingRef');
  });

  it('stores the allowlisted keys alone and hands the acting member to the filter alone', async () => {
    await listener.handleInvited(event);
    await listener.handleRequested(event);
    await listener.handleAccepted(event);

    expect(notifications.createForRecipients).toHaveBeenCalledTimes(3);
    for (const call of notifications.createForRecipients.mock.calls as [
      string[],
      NotificationType,
      Record<string, unknown>,
      string,
    ][]) {
      const [recipientIds, type, payload, actorId] = call;
      const allowedKeys = ALLOWLIST[type] ?? [];
      for (const key of Object.keys(payload)) {
        expect(allowedKeys).toContain(key);
      }
      for (const value of Object.values(payload)) {
        expect(KNOWN_USER_IDS).not.toContain(value);
      }
      expect(actorId).toBe(ACTING_USER);
      expect(recipientIds).not.toContain(ACTING_USER);
    }
  });

  it('sends nothing when the row no longer holds the status', async () => {
    teamRows = [];

    await listener.handleInvited(event);
    await listener.handleRequested(event);
    await listener.handleAccepted(event);

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('sends nothing when the starting side has no one left', async () => {
    listingRecipients = [];

    await listener.handleRequested(event);
    await listener.handleAccepted(event);

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('swallows a failure and logs the member id alone', async () => {
    notifications.createForRecipients.mockRejectedValue(new Error('down'));
    const warn = jest
      .spyOn(
        (listener as unknown as { logger: { warn: (message: string) => void } })
          .logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await expect(listener.handleInvited(event)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain(MEMBER_ID);
    for (const userId of KNOWN_USER_IDS) {
      expect(line).not.toContain(userId);
    }
  });
});

import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CREDIT_ALERT_RECIPIENTS_SQL,
  CREDIT_ALERT_SQL,
  StudioCreditAlertsListener,
} from './studio-credit-alerts.listener';

const CREDIT_ID = 'f8000000-0000-4000-8000-000000000001';
const REQUESTING_MEMBER = 'f8000000-0000-4000-8000-000000000002';
const ACCEPTING_MEMBER = 'f8000000-0000-4000-8000-000000000003';
const CREDITED_OWNER = 'f8000000-0000-4000-8000-000000000004';
const RELEASE_OWNER = 'f8000000-0000-4000-8000-000000000005';

const alertRow = {
  credit_id: CREDIT_ID,
  role: 'cover-art',
  credited_subprofile_id: 'persona-credited',
  credited_persona_name: 'River Ink',
  credited_persona_handle: 'river-ink',
  requesting_subprofile_id: 'persona-requesting',
  requesting_persona_name: 'Night Shift',
  requesting_persona_handle: 'night-shift',
  requesting_link_visibility: 'linked',
  credited_link_visibility: 'linked',
  track_id: 'track-1',
  track_title: 'Opening',
  release_id: 'release-1',
  release_title: 'Lisbon at four',
};

describe('StudioCreditAlertsListener', () => {
  let query: jest.Mock;
  let notifications: { createForRecipients: jest.Mock };
  let listener: StudioCreditAlertsListener;

  beforeEach(() => {
    query = jest.fn((sql: string, parameters: unknown[]) =>
      Promise.resolve(
        sql === CREDIT_ALERT_SQL
          ? [alertRow]
          : parameters[0] === 'persona-credited'
            ? [{ user_id: CREDITED_OWNER }]
            : [{ user_id: RELEASE_OWNER }],
      ),
    );
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue([]),
    };
    listener = new StudioCreditAlertsListener(
      { query } as unknown as DataSource,
      notifications as unknown as NotificationsService,
    );
  });

  it('hands the requesting member to the fan-out as the actor and keeps every member field off the payload', async () => {
    await listener.handleCreditRequested({
      creditId: CREDIT_ID,
      requestingUserId: REQUESTING_MEMBER,
    });

    expect(query).toHaveBeenCalledWith(CREDIT_ALERT_SQL, [
      CREDIT_ID,
      'pending',
    ]);
    expect(query).toHaveBeenCalledWith(CREDIT_ALERT_RECIPIENTS_SQL, [
      'persona-credited',
      REQUESTING_MEMBER,
    ]);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      [CREDITED_OWNER],
      NotificationType.StudioCreditRequested,
      {
        creditId: CREDIT_ID,
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
      },
      REQUESTING_MEMBER,
    );
  });

  it('tells the requesting persona, minus the accepting member, about an accepted credit', async () => {
    await listener.handleCreditAccepted({
      creditId: CREDIT_ID,
      acceptingUserId: ACCEPTING_MEMBER,
    });

    expect(query).toHaveBeenCalledWith(CREDIT_ALERT_SQL, [
      CREDIT_ID,
      'accepted',
    ]);
    expect(query).toHaveBeenCalledWith(CREDIT_ALERT_RECIPIENTS_SQL, [
      'persona-requesting',
      ACCEPTING_MEMBER,
    ]);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      [RELEASE_OWNER],
      NotificationType.StudioCreditAccepted,
      {
        creditId: CREDIT_ID,
        requestingSubprofileId: 'persona-requesting',
        requestingPersonaName: 'Night Shift',
        creditedPersonaName: 'River Ink',
        creditedPersonaHandle: 'river-ink',
        trackId: 'track-1',
        trackTitle: 'Opening',
        releaseId: 'release-1',
        releaseTitle: 'Lisbon at four',
        role: 'cover-art',
      },
      ACCEPTING_MEMBER,
    );
  });

  // SEC-02: an unlinked acting persona passes no member to filter against,
  // so a request or acceptance that vanished on a block cannot test who
  // runs it.
  it('passes no actor when the requesting or the accepting persona is unlinked', async () => {
    query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql === CREDIT_ALERT_SQL
          ? [
              {
                ...alertRow,
                requesting_link_visibility: 'unlinked',
                credited_link_visibility: 'unlinked',
              },
            ]
          : [{ user_id: CREDITED_OWNER }],
      ),
    );

    await listener.handleCreditRequested({
      creditId: CREDIT_ID,
      requestingUserId: REQUESTING_MEMBER,
    });
    await listener.handleCreditAccepted({
      creditId: CREDIT_ID,
      acceptingUserId: ACCEPTING_MEMBER,
    });

    expect(notifications.createForRecipients).toHaveBeenCalledTimes(2);
    for (const call of notifications.createForRecipients.mock.calls) {
      expect((call as unknown[])[3]).toBeUndefined();
    }
    expect(CREDIT_ALERT_SQL).toContain(
      '"requesting"."link_visibility"::text AS "requesting_link_visibility"',
    );
  });

  it('sends nothing for a credit that is gone, answered or out of public reach', async () => {
    query.mockResolvedValue([]);
    await listener.handleCreditRequested({
      creditId: CREDIT_ID,
      requestingUserId: REQUESTING_MEMBER,
    });
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(CREDIT_ALERT_SQL).toContain(`"release"."status" <> 'taken_down'`);
    expect(CREDIT_ALERT_SQL).toContain(`"requesting"."visibility" = 'open'`);
    expect(CREDIT_ALERT_SQL).toContain(`"credited"."visibility" = 'open'`);
  });

  it('reads recipients holding a Studio grant, the acting member left out', () => {
    expect(CREDIT_ALERT_RECIPIENTS_SQL).toContain('"member"."user_id" <> $2');
    expect(CREDIT_ALERT_RECIPIENTS_SQL).toContain('"studio_access_grants"');
  });

  it('swallows a failure, since the request has already committed', async () => {
    query.mockRejectedValue(new Error('connection reset'));
    await expect(
      listener.handleCreditAccepted({
        creditId: CREDIT_ID,
        acceptingUserId: ACCEPTING_MEMBER,
      }),
    ).resolves.toBeUndefined();
  });
});

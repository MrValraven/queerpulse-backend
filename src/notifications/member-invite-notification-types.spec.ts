import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { Profile } from '../users/entities/profile.entity';
import { Notification, NotificationType } from './entities/notification.entity';
import {
  NotificationPreferenceCategory,
  categoryForType,
} from './notification-preferences';
import { ACTOR_PAYLOAD_KEY, toClientPayload } from './notification-response';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

const INVITE_TYPES = [
  NotificationType.EventInviteRequest,
  NotificationType.EventInviteRequestDeclined,
  NotificationType.EventInviteAccepted,
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
    createdAt: new Date('2026-10-21T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

describe('Member invite notification types', () => {
  it('stores the labels the migration adds', () => {
    expect(NotificationType.EventInviteRequest).toBe('event_invite_request');
    expect(NotificationType.EventInviteRequestDeclined).toBe(
      'event_invite_request_declined',
    );
    expect(NotificationType.EventInviteAccepted).toBe('event_invite_accepted');
  });

  it('request, declined and accepted answer to the EventActivity switch', () => {
    for (const type of INVITE_TYPES) {
      expect(categoryForType(type)).toBe(
        NotificationPreferenceCategory.EventActivity,
      );
    }
  });

  it('request and accepted resolve their actor from actorId', () => {
    expect(ACTOR_PAYLOAD_KEY[NotificationType.EventInviteRequest]).toBe(
      'actorId',
    );
    expect(ACTOR_PAYLOAD_KEY[NotificationType.EventInviteAccepted]).toBe(
      'actorId',
    );
    expect(
      ACTOR_PAYLOAD_KEY[NotificationType.EventInviteRequestDeclined],
    ).toBeUndefined();
  });

  it('allowlist forwards eventTitle and drops actorId', () => {
    for (const type of INVITE_TYPES) {
      expect(
        toClientPayload(
          notificationRow(type, {
            source: 'member_invite_reply',
            actorId: 'member-1',
            eventSlug: 'pride-picnic',
            eventTitle: 'Pride picnic',
            inviteId: 'invite-1',
          }),
        ),
      ).toEqual({
        source: 'member_invite_reply',
        eventSlug: 'pride-picnic',
        eventTitle: 'Pride picnic',
        inviteId: 'invite-1',
      });
    }
  });
});

describe('Member invite listener handlers', () => {
  let listener: NotificationsListener;
  let notifications: { create: jest.Mock; createForRecipients: jest.Mock };

  beforeEach(async () => {
    notifications = { create: jest.fn(), createForRecipients: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        NotificationsListener,
        { provide: NotificationsService, useValue: notifications },
        { provide: getRepositoryToken(SubprofileMember), useValue: {} },
        { provide: getRepositoryToken(Profile), useValue: {} },
      ],
    }).compile();
    listener = module.get(NotificationsListener);
  });

  it('onEventInvited carries source event_invite and eventSlug', async () => {
    await listener.onEventInvited({
      eventId: 'event-1',
      eventSlug: 'pride-picnic',
      inviteId: 'invite-1',
      inviterId: 'inviter-1',
      inviteeId: 'invitee-1',
    });
    expect(notifications.create).toHaveBeenCalledWith(
      'invitee-1',
      NotificationType.EventInvite,
      {
        source: 'event_invite',
        eventId: 'event-1',
        eventSlug: 'pride-picnic',
        inviteId: 'invite-1',
        inviterId: 'inviter-1',
      },
      'inviter-1',
    );
  });

  it('onEventInviteRequested writes one row per organiser with source member_invite_request', async () => {
    await listener.onEventInviteRequested({
      eventId: 'event-1',
      eventSlug: 'pride-picnic',
      eventTitle: 'Pride picnic',
      inviteId: 'invite-1',
      inviterId: 'inviter-1',
      inviteeId: 'invitee-1',
      organiserIds: ['host-1', 'cohost-1'],
    });
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['host-1', 'cohost-1'],
      NotificationType.EventInviteRequest,
      {
        source: 'member_invite_request',
        actorId: 'inviter-1',
        eventSlug: 'pride-picnic',
        eventTitle: 'Pride picnic',
        inviteId: 'invite-1',
      },
      'inviter-1',
    );
  });

  it('onEventInviteRequestDeclined tells the inviter with no actor', async () => {
    await listener.onEventInviteRequestDeclined({
      eventId: 'event-1',
      eventSlug: 'pride-picnic',
      eventTitle: 'Pride picnic',
      inviteId: 'invite-1',
      inviterId: 'inviter-1',
    });
    expect(notifications.create).toHaveBeenCalledWith(
      'inviter-1',
      NotificationType.EventInviteRequestDeclined,
      {
        source: 'member_invite_reply',
        eventSlug: 'pride-picnic',
        eventTitle: 'Pride picnic',
        inviteId: 'invite-1',
      },
    );
  });

  it('onEventInviteAccepted tells the inviter with the invitee as actor', async () => {
    await listener.onEventInviteAccepted({
      eventId: 'event-1',
      eventSlug: 'pride-picnic',
      eventTitle: 'Pride picnic',
      inviteId: 'invite-1',
      inviterId: 'inviter-1',
      inviteeId: 'invitee-1',
    });
    expect(notifications.create).toHaveBeenCalledWith(
      'inviter-1',
      NotificationType.EventInviteAccepted,
      {
        source: 'member_invite_reply',
        actorId: 'invitee-1',
        eventSlug: 'pride-picnic',
        eventTitle: 'Pride picnic',
        inviteId: 'invite-1',
      },
      'invitee-1',
    );
  });
});

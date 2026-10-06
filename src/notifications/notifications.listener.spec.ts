import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { Profile } from '../users/entities/profile.entity';
import { NotificationType } from './entities/notification.entity';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

describe('NotificationsListener', () => {
  let listener: NotificationsListener;
  let notifications: { create: jest.Mock; createForRecipients: jest.Mock };
  let subprofileMembers: { find: jest.Mock; manager: { findOne: jest.Mock } };
  let profiles: { findOne: jest.Mock };

  beforeEach(async () => {
    notifications = { create: jest.fn(), createForRecipients: jest.fn() };
    subprofileMembers = {
      find: jest.fn(),
      manager: {
        findOne: jest.fn().mockResolvedValue({
          id: 'sp1',
          displayName: 'Persona One',
        }),
      },
    };
    profiles = { findOne: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsListener,
        { provide: NotificationsService, useValue: notifications },
        {
          provide: getRepositoryToken(SubprofileMember),
          useValue: subprofileMembers,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
      ],
    }).compile();
    listener = module.get(NotificationsListener);
  });

  it('notifies the addressee on a connection request', async () => {
    await listener.onConnectionRequested({
      connectionId: 'c1',
      requesterId: 'r',
      addresseeId: 'a',
    });
    expect(notifications.create).toHaveBeenCalledWith(
      'a',
      NotificationType.ConnectionRequest,
      expect.objectContaining({ connectionId: 'c1', fromUserId: 'r' }),
      'r',
    );
  });

  it('also notifies the introducer when the request was introduced', async () => {
    await listener.onConnectionRequested({
      connectionId: 'c1',
      requesterId: 'r',
      addresseeId: 'a',
      introducedBy: 'intro',
    });
    expect(notifications.create).toHaveBeenCalledWith(
      'intro',
      NotificationType.IntroductionMade,
      { connectionId: 'c1', requesterId: 'r', addresseeId: 'a' },
      'r',
    );
  });

  it('notifies the vouchee on a vouch', async () => {
    await listener.onVouchCreated({ voucherId: 'v', voucheeId: 'u' });
    expect(notifications.create).toHaveBeenCalledWith(
      'u',
      NotificationType.VouchReceived,
      expect.objectContaining({ voucherId: 'v' }),
      'v',
    );
  });

  it('notifies an invitee on an event invite, carrying the invite id', async () => {
    await listener.onEventInvited({
      eventId: 'e1',
      inviteId: 'i1',
      inviterId: 'host',
      inviteeId: 'u2',
    });
    expect(notifications.create).toHaveBeenCalledWith(
      'u2',
      NotificationType.EventInvite,
      expect.objectContaining({
        eventId: 'e1',
        inviteId: 'i1',
        inviterId: 'host',
      }),
      'host',
    );
  });

  // Every member-triggered notification above passes the acting member as a
  // trailing `actorId` so `NotificationsService` can suppress it when that
  // actor is blocked/muted by the recipient. The two system-generated types
  // below pass no actor: nobody is behind them to filter on, so they must
  // always be delivered.
  it('notifies a member promoted off the event waitlist, with no actor', async () => {
    await listener.onWaitlistPromoted({
      eventId: 'e1',
      eventSlug: 'e1-slug',
      userId: 'u2',
    });
    expect(notifications.create).toHaveBeenCalledWith(
      'u2',
      NotificationType.WaitlistPromoted,
      expect.objectContaining({ eventId: 'e1', eventSlug: 'e1-slug' }),
    );
    expect(notifications.create.mock.calls[0]).toHaveLength(3);
  });

  it('notifies a promoted member with no actor', async () => {
    await listener.onUserPromoted({ userId: 'u2' });
    expect(notifications.create).toHaveBeenCalledWith(
      'u2',
      NotificationType.PromotedToMember,
      {},
    );
    expect(notifications.create.mock.calls[0]).toHaveLength(3);
  });

  it('notifies the invitee on a subprofile co-owner invite', async () => {
    await listener.onSubprofileInvited({
      subprofileId: 'sp1',
      invitedUserId: 'u2',
      invitedByUserId: 'owner',
      displayName: 'Persona One',
    });
    expect(notifications.create).toHaveBeenCalledWith(
      'u2',
      NotificationType.SubprofileInvite,
      {
        subprofileId: 'sp1',
        subprofileName: 'Persona One',
        invitedByUserId: 'owner',
      },
      'owner',
    );
  });

  describe('persona endorsed and followed', () => {
    it('names the endorsed persona and keeps the endorser out of the payload', async () => {
      await listener.onSubprofileEndorsed({
        subprofileId: 'sp1',
        endorserId: 'fan-1',
        ownerId: 'owner',
      });
      expect(subprofileMembers.manager.findOne).toHaveBeenCalledWith(
        Subprofile,
        {
          where: { id: 'sp1' },
          select: { id: true, displayName: true },
        },
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'owner',
        NotificationType.PersonaEndorsed,
        { subprofileId: 'sp1', subprofileName: 'Persona One' },
        'fan-1',
      );
    });

    it('names the followed persona and keeps the follower out of the payload', async () => {
      await listener.onSubprofileFollowed({
        subprofileId: 'sp1',
        followerId: 'fan-2',
        ownerId: 'owner',
      });
      expect(notifications.create).toHaveBeenCalledWith(
        'owner',
        NotificationType.PersonaFollowed,
        { subprofileId: 'sp1', subprofileName: 'Persona One' },
        'fan-2',
      );
    });

    it('still delivers the row without a name when the persona is gone', async () => {
      subprofileMembers.manager.findOne.mockResolvedValue(null);
      await listener.onSubprofileFollowed({
        subprofileId: 'sp1',
        followerId: 'fan-2',
        ownerId: 'owner',
      });
      expect(notifications.create).toHaveBeenCalledWith(
        'owner',
        NotificationType.PersonaFollowed,
        { subprofileId: 'sp1' },
        'fan-2',
      );
    });

    it('still delivers the row without a name when the name lookup fails', async () => {
      subprofileMembers.manager.findOne.mockRejectedValue(new Error('db down'));
      await listener.onSubprofileEndorsed({
        subprofileId: 'sp1',
        endorserId: 'fan-1',
        ownerId: 'owner',
      });
      expect(notifications.create).toHaveBeenCalledWith(
        'owner',
        NotificationType.PersonaEndorsed,
        { subprofileId: 'sp1' },
        'fan-1',
      );
    });
  });

  it('notifies the other current co-owners when an invite is accepted, excluding the joiner', async () => {
    subprofileMembers.find.mockResolvedValue([
      { userId: 'owner' },
      { userId: 'u2' },
      { userId: 'newJoiner' },
    ]);
    await listener.onSubprofileInviteAccepted({
      subprofileId: 'sp1',
      joinedUserId: 'newJoiner',
      invitedByUserId: 'owner',
    });
    expect(subprofileMembers.find).toHaveBeenCalledWith({
      where: { subprofileId: 'sp1' },
      select: { userId: true },
    });
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['owner', 'u2'],
      NotificationType.SubprofileCoOwnerJoined,
      {
        subprofileId: 'sp1',
        joinedUserId: 'newJoiner',
        subprofileName: 'Persona One',
      },
      'newJoiner',
    );
    // One name lookup for the whole fan-out.
    expect(subprofileMembers.manager.findOne).toHaveBeenCalledTimes(1);
  });

  it('skips the fan-out when the joiner was the only co-owner found', async () => {
    subprofileMembers.find.mockResolvedValue([{ userId: 'newJoiner' }]);
    await listener.onSubprofileInviteAccepted({
      subprofileId: 'sp1',
      joinedUserId: 'newJoiner',
      invitedByUserId: 'owner',
    });
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(subprofileMembers.manager.findOne).not.toHaveBeenCalled();
  });

  it('notifies the invitee with a cohost_invite-sourced deep-link payload', async () => {
    await listener.onEventCohostInvited({
      eventId: 'e1',
      eventSlug: 'pride-picnic',
      inviteId: 'i1',
      inviterId: 'host-1',
      inviteeId: 'invitee-1',
    });

    expect(notifications.create).toHaveBeenCalledWith(
      'invitee-1',
      NotificationType.EventCohostInvite,
      { source: 'cohost_invite', eventSlug: 'pride-picnic', inviteId: 'i1' },
      'host-1',
    );
  });

  it('notifies the invitee of a lineup invite with the deep-link payload', async () => {
    await listener.onEventLineupInvited({
      entryId: 'entry-1',
      eventId: 'event-1',
      eventSlug: 'drag-brunch',
      inviterId: 'host-user',
      inviteeId: 'dj-user',
      role: 'dj',
    });
    expect(notifications.create).toHaveBeenCalledWith(
      'dj-user',
      NotificationType.EventLineupInvite,
      {
        actorId: 'host-user',
        source: 'lineup_invite',
        eventSlug: 'drag-brunch',
        inviteId: 'entry-1',
        role: 'dj',
      },
      'host-user',
    );
  });

  it.each([
    ['accepted', NotificationType.EventLineupAccepted],
    ['declined', NotificationType.EventLineupDeclined],
  ] as const)(
    'notifies the inviter when a lineup invite is %s',
    async (outcome, expectedType) => {
      await listener.onEventLineupAnswered({
        entryId: 'entry-1',
        eventId: 'event-1',
        eventSlug: 'drag-brunch',
        performerId: 'dj-user',
        recipientId: 'host-user',
        role: 'dj',
        outcome,
      });
      expect(notifications.create).toHaveBeenCalledWith(
        'host-user',
        expectedType,
        {
          actorId: 'dj-user',
          source: 'lineup_reply',
          eventSlug: 'drag-brunch',
          role: 'dj',
        },
        'dj-user',
      );
    },
  );

  describe('onSubprofileCreatorChanged', () => {
    it('notifies the successor with isYou true and the other members with isYou false, no actor', async () => {
      profiles.findOne.mockResolvedValue({
        firstName: 'Ana',
        lastName: 'Silva',
      });

      await listener.onSubprofileCreatorChanged({
        subprofileId: 'sp1',
        displayName: 'Persona One',
        newCreatorUserId: 'successor',
        memberUserIds: ['successor', 'u2', 'u3'],
      });

      expect(profiles.findOne).toHaveBeenCalledWith({
        where: { userId: 'successor' },
      });
      expect(notifications.createForRecipients).toHaveBeenNthCalledWith(
        1,
        ['successor'],
        NotificationType.SubprofileCreatorChanged,
        {
          subprofileName: 'Persona One',
          newCreatorName: 'Ana Silva',
          isYou: true,
        },
      );
      expect(notifications.createForRecipients).toHaveBeenNthCalledWith(
        2,
        ['u2', 'u3'],
        NotificationType.SubprofileCreatorChanged,
        {
          subprofileName: 'Persona One',
          newCreatorName: 'Ana Silva',
          isYou: false,
        },
      );
      // No actor argument on either call: this must reach every remaining
      // member regardless of a block or mute against the departing creator.
      expect(notifications.createForRecipients.mock.calls[0]).toHaveLength(3);
      expect(notifications.createForRecipients.mock.calls[1]).toHaveLength(3);
    });

    it('falls back to a neutral name when the successor has no profile row', async () => {
      profiles.findOne.mockResolvedValue(null);

      await listener.onSubprofileCreatorChanged({
        subprofileId: 'sp1',
        displayName: 'Persona One',
        newCreatorUserId: 'successor',
        memberUserIds: ['successor'],
      });

      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        ['successor'],
        NotificationType.SubprofileCreatorChanged,
        {
          subprofileName: 'Persona One',
          newCreatorName: 'Member',
          isYou: true,
        },
      );
    });

    it('skips the second fan-out when the successor is the only remaining member', async () => {
      profiles.findOne.mockResolvedValue({
        firstName: 'Ana',
        lastName: 'Silva',
      });

      await listener.onSubprofileCreatorChanged({
        subprofileId: 'sp1',
        displayName: 'Persona One',
        newCreatorUserId: 'successor',
        memberUserIds: ['successor'],
      });

      expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
    });
  });
});

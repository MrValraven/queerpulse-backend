import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { NotificationType } from './entities/notification.entity';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

describe('NotificationsListener', () => {
  let listener: NotificationsListener;
  let notifications: { create: jest.Mock; createForRecipients: jest.Mock };
  let subprofileMembers: { find: jest.Mock };

  beforeEach(async () => {
    notifications = { create: jest.fn(), createForRecipients: jest.fn() };
    subprofileMembers = { find: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsListener,
        { provide: NotificationsService, useValue: notifications },
        {
          provide: getRepositoryToken(SubprofileMember),
          useValue: subprofileMembers,
        },
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
        displayName: 'Persona One',
        invitedByUserId: 'owner',
      },
      'owner',
    );
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
      { subprofileId: 'sp1', joinedUserId: 'newJoiner' },
      'newJoiner',
    );
  });

  it('skips the fan-out when the joiner was the only co-owner found', async () => {
    subprofileMembers.find.mockResolvedValue([{ userId: 'newJoiner' }]);
    await listener.onSubprofileInviteAccepted({
      subprofileId: 'sp1',
      joinedUserId: 'newJoiner',
      invitedByUserId: 'owner',
    });
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });
});

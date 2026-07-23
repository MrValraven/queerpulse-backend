import { Test, TestingModule } from '@nestjs/testing';
import { NotificationType } from './entities/notification.entity';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

describe('NotificationsListener', () => {
  let listener: NotificationsListener;
  let notifications: { create: jest.Mock; createForRecipients: jest.Mock };

  beforeEach(async () => {
    notifications = { create: jest.fn(), createForRecipients: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsListener,
        { provide: NotificationsService, useValue: notifications },
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
    await listener.onWaitlistPromoted({ eventId: 'e1', userId: 'u2' });
    expect(notifications.create).toHaveBeenCalledWith(
      'u2',
      NotificationType.WaitlistPromoted,
      expect.objectContaining({ eventId: 'e1' }),
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
});

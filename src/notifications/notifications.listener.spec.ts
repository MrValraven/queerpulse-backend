import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { NotificationType } from './entities/notification.entity';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

describe('NotificationsListener', () => {
  let listener: NotificationsListener;
  let notifications: { create: jest.Mock; createForRecipients: jest.Mock };
  let participants: { find: jest.Mock };

  beforeEach(async () => {
    notifications = { create: jest.fn(), createForRecipients: jest.fn() };
    participants = { find: jest.fn().mockResolvedValue([]) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsListener,
        { provide: NotificationsService, useValue: notifications },
        {
          provide: getRepositoryToken(ConversationParticipant),
          useValue: participants,
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
    );
  });

  it('fans a new message out to non-sender, non-muted participants', async () => {
    participants.find.mockResolvedValue([
      { userId: 'b', muted: false },
      { userId: 'c', muted: true },
    ]);
    await listener.onMessageCreated({
      conversationId: 'conv1',
      message: { id: 'm1', senderId: 'a' } as never,
    });
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['b'],
      NotificationType.NewMessage,
      expect.objectContaining({ conversationId: 'conv1', senderId: 'a' }),
    );
  });

  it('notifies the vouchee on a vouch', async () => {
    await listener.onVouchCreated({ voucherId: 'v', voucheeId: 'u' });
    expect(notifications.create).toHaveBeenCalledWith(
      'u',
      NotificationType.VouchReceived,
      expect.objectContaining({ voucherId: 'v' }),
    );
  });
});

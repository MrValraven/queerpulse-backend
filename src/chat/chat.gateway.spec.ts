import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConnectionsService } from '../connections/connections.service';
import { MessagingService } from '../messaging/messaging.service';
import { ChatGateway } from './chat.gateway';
import { PresenceService } from './presence.service';

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let messaging: {
    sendMessage: jest.Mock;
    markRead: jest.Mock;
    isParticipant: jest.Mock;
  };
  let emit: jest.Mock;

  beforeEach(async () => {
    messaging = {
      sendMessage: jest.fn().mockResolvedValue({ id: 'm1' }),
      markRead: jest.fn().mockResolvedValue({ ok: true }),
      isParticipant: jest.fn().mockResolvedValue(true),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        PresenceService,
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        { provide: ConfigService, useValue: { getOrThrow: () => 'secret' } },
        { provide: MessagingService, useValue: messaging },
        {
          provide: ConnectionsService,
          useValue: {
            getAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    gateway = module.get(ChatGateway);

    // Stub the namespace the gateway broadcasts through.
    emit = jest.fn();
    // @ts-expect-error assigning the injected namespace for the test
    gateway.namespace = { to: jest.fn().mockReturnValue({ emit }) };
  });

  it('broadcasts message:new to the conversation room on MESSAGE_CREATED', () => {
    gateway.handleMessageCreated({
      conversationId: 'c1',
      message: { id: 'm1' } as never,
    });
    expect(gateway.namespace.to).toHaveBeenCalledWith('c1');
    expect(emit).toHaveBeenCalledWith(
      'message:new',
      expect.objectContaining({ conversationId: 'c1' }),
    );
  });

  it('conversation:join rejects a non-participant', async () => {
    messaging.isParticipant.mockResolvedValue(false);
    const client = { data: { userId: 'u1' }, join: jest.fn() } as never;
    await expect(
      gateway.handleJoin(client, { conversationId: 'c1' }),
    ).rejects.toBeDefined();
  });

  it('message:send delegates to the single write path (no direct broadcast)', async () => {
    const client = { data: { userId: 'u1' } } as never;
    await gateway.handleSend(client, { conversationId: 'c1', body: 'hi' });
    expect(messaging.sendMessage).toHaveBeenCalledWith('c1', 'u1', 'hi');
  });
});

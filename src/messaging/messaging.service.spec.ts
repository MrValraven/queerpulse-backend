import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { ConnectionsService } from '../connections/connections.service';
import { Conversation } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Message } from './entities/message.entity';
import { MessagingService } from './messaging.service';

describe('MessagingService.sendMessage', () => {
  let service: MessagingService;
  let participants: { findOne: jest.Mock };
  let conversations: { findOne: jest.Mock };
  let messages: { create: jest.Mock; save: jest.Mock };
  let connections: { areConnected: jest.Mock };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    participants = { findOne: jest.fn() };
    conversations = { findOne: jest.fn() };
    messages = {
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => ({ id: 'm1', createdAt: new Date(), editedAt: null, ...v })),
    };
    connections = { areConnected: jest.fn().mockResolvedValue(true) };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(Conversation), useValue: conversations },
        {
          provide: getRepositoryToken(ConversationParticipant),
          useValue: participants,
        },
        { provide: getRepositoryToken(Message), useValue: messages },
        { provide: getRepositoryToken(Profile), useValue: { find: jest.fn() } },
        { provide: DataSource, useValue: {} },
        { provide: EventEmitter2, useValue: emitter },
        { provide: ConnectionsService, useValue: connections },
      ],
    }).compile();
    service = module.get(MessagingService);
  });

  it('rejects a non-participant', async () => {
    participants.findOne.mockResolvedValueOnce(null); // sender participant lookup
    await expect(
      service.sendMessage('c1', 'intruder', 'hi'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects when the participants are no longer connected', async () => {
    participants.findOne
      .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' }) // sender
      .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' }); // other
    conversations.findOne.mockResolvedValue({ id: 'c1', isOfficial: false });
    connections.areConnected.mockResolvedValue(false);
    await expect(
      service.sendMessage('c1', 'me', 'hi'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('persists and emits message.created on a valid send', async () => {
    participants.findOne
      .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
      .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
    conversations.findOne.mockResolvedValue({ id: 'c1', isOfficial: false });
    connections.areConnected.mockResolvedValue(true);

    const result = await service.sendMessage('c1', 'me', 'hello');
    expect(result.body).toBe('hello');
    expect(emitter.emit).toHaveBeenCalledWith(
      'message.created',
      expect.objectContaining({ conversationId: 'c1' }),
    );
  });
});

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Profile } from '../users/entities/profile.entity';
import {
  Connection,
  ConnectionStatus,
} from './entities/connection.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import { ConnectionsService } from './connections.service';

describe('ConnectionsService', () => {
  let service: ConnectionsService;
  let connections: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    find: jest.Mock;
  };
  let profiles: { findOne: jest.Mock; find: jest.Mock };
  let vouches: { find: jest.Mock };

  beforeEach(async () => {
    connections = {
      findOne: jest.fn(),
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => ({ id: 'c1', ...v })),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
    };
    profiles = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    vouches = { find: jest.fn().mockResolvedValue([]) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConnectionsService,
        { provide: getRepositoryToken(Connection), useValue: connections },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(Vouch), useValue: vouches },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    service = module.get(ConnectionsService);
  });

  it('rejects connecting to yourself', async () => {
    profiles.findOne.mockResolvedValue({ userId: 'me', slug: 'me' });
    await expect(
      service.requestConnection('me', 'me'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates a pending request when no pair row exists', async () => {
    profiles.findOne.mockResolvedValue({ userId: 'them', slug: 'them' });
    connections.findOne.mockResolvedValue(null);
    const result = await service.requestConnection('me', 'them', 'hi there');
    expect(connections.save).toHaveBeenCalled();
    expect(result.status).toBe(ConnectionStatus.Pending);
    expect(result.requestMessage).toBe('hi there');
  });

  it('rejects a new request when already connected', async () => {
    profiles.findOne.mockResolvedValue({ userId: 'them', slug: 'them' });
    connections.findOne.mockResolvedValue({
      id: 'c1',
      status: ConnectionStatus.Accepted,
    });
    await expect(
      service.requestConnection('me', 'them'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('only the addressee can accept a pending request', async () => {
    connections.findOne.mockResolvedValue({
      id: 'c1',
      requesterId: 'me',
      addresseeId: 'them',
      status: ConnectionStatus.Pending,
    });
    await expect(
      service.respond('c1', 'me', 'accept'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts a pending request as the addressee', async () => {
    connections.findOne.mockResolvedValue({
      id: 'c1',
      requesterId: 'them',
      addresseeId: 'me',
      status: ConnectionStatus.Pending,
    });
    const result = await service.respond('c1', 'me', 'accept');
    expect(result.status).toBe(ConnectionStatus.Accepted);
    expect(result.respondedAt).toBeInstanceOf(Date);
  });

  it('only the blocker can unblock', async () => {
    connections.findOne.mockResolvedValue({
      id: 'c1',
      requesterId: 'me',
      addresseeId: 'them',
      status: ConnectionStatus.Blocked,
      blockedBy: 'them',
    });
    await expect(
      service.respond('c1', 'me', 'unblock'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('areConnected is true only for an accepted pair', async () => {
    connections.findOne.mockResolvedValue({ status: ConnectionStatus.Accepted });
    await expect(service.areConnected('a', 'b')).resolves.toBe(true);
    connections.findOne.mockResolvedValue({ status: ConnectionStatus.Pending });
    await expect(service.areConnected('a', 'b')).resolves.toBe(false);
  });
});

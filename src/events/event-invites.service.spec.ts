import { ConflictException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { EventInvite, EventInviteStatus } from './entities/event-invite.entity';
import { Event } from './entities/event.entity';
import { EventInvitesService } from './event-invites.service';
import { EventsService } from './events.service';

describe('EventInvitesService', () => {
  let service: EventInvitesService;
  let invites: { findOne: jest.Mock; save: jest.Mock };
  let eventsService: { isOrganizer: jest.Mock };

  beforeEach(async () => {
    invites = { findOne: jest.fn(), save: jest.fn(async (i) => i) };
    eventsService = { isOrganizer: jest.fn().mockResolvedValue(true) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventInvitesService,
        { provide: getRepositoryToken(EventInvite), useValue: invites },
        { provide: getRepositoryToken(Event), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Profile), useValue: { find: jest.fn() } },
        { provide: EventsService, useValue: eventsService },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    service = module.get(EventInvitesService);
  });

  it('respondInvite rejects a non-invitee', async () => {
    invites.findOne.mockResolvedValue({
      id: 'i1',
      inviteeId: 'someone',
      status: EventInviteStatus.Pending,
    });
    await expect(
      service.respondInvite('i1', 'intruder', 'accept'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('respondInvite rejects a non-pending invite', async () => {
    invites.findOne.mockResolvedValue({
      id: 'i1',
      inviteeId: 'u1',
      status: EventInviteStatus.Accepted,
    });
    await expect(
      service.respondInvite('i1', 'u1', 'accept'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('respondInvite accepts a pending invite for its invitee', async () => {
    invites.findOne.mockResolvedValue({
      id: 'i1',
      inviteeId: 'u1',
      status: EventInviteStatus.Pending,
    });
    const result = await service.respondInvite('i1', 'u1', 'accept');
    expect(result.status).toBe(EventInviteStatus.Accepted);
  });
});

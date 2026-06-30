import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { EventCohost } from './entities/event-cohost.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';
import { EventsService } from './events.service';

describe('EventsService', () => {
  let service: EventsService;
  let events: { findOne: jest.Mock; save: jest.Mock; exists: jest.Mock };
  let cohosts: { exists: jest.Mock; find: jest.Mock };

  beforeEach(async () => {
    events = {
      findOne: jest.fn(),
      save: jest.fn(async (e) => e),
      exists: jest.fn().mockResolvedValue(false),
    };
    cohosts = { exists: jest.fn().mockResolvedValue(false), find: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventCohost), useValue: cohosts },
        {
          provide: getRepositoryToken(EventRsvp),
          useValue: { count: jest.fn().mockResolvedValue(0), findOne: jest.fn() },
        },
        { provide: getRepositoryToken(Profile), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: UsersService, useValue: { findById: jest.fn() } },
      ],
    }).compile();
    service = module.get(EventsService);
  });

  it('isOrganizer is true for the host', async () => {
    events.findOne.mockResolvedValue({ id: 'e1', hostId: 'u1' });
    await expect(service.isOrganizer('e1', 'u1')).resolves.toBe(true);
  });

  it('isOrganizer falls back to the co-host check', async () => {
    events.findOne.mockResolvedValue({ id: 'e1', hostId: 'host' });
    cohosts.exists.mockResolvedValue(true);
    await expect(service.isOrganizer('e1', 'u2')).resolves.toBe(true);
  });

  it('update rejects a non-organizer', async () => {
    events.findOne.mockResolvedValue({ id: 'e1', slug: 'x', hostId: 'host' });
    cohosts.exists.mockResolvedValue(false);
    await expect(
      service.update('x', 'intruder', { title: 'new' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('getBySlug 404s an unknown slug', async () => {
    events.findOne.mockResolvedValue(null);
    await expect(service.getBySlug('nope', 'u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

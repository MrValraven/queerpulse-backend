import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { EventStatus, EventVisibility } from './entities/event.entity';
import { RsvpService } from './rsvp.service';

describe('RsvpService', () => {
  let service: RsvpService;
  let managerFindOne: jest.Mock;
  let managerExists: jest.Mock;
  let rsvpRepo: {
    count: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    managerFindOne = jest.fn();
    managerExists = jest.fn().mockResolvedValue(false);
    rsvpRepo = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(async (r) => r),
      create: jest.fn((r) => r),
      createQueryBuilder: jest.fn(() => ({
        select: () => ({
          where: () => ({ getRawOne: async () => ({ max: 0 }) }),
        }),
      })),
    };
    emitter = { emit: jest.fn() };
    const manager = {
      getRepository: () => rsvpRepo,
      findOne: managerFindOne,
      exists: managerExists,
    };
    const dataSource = {
      transaction: jest.fn(async (cb) => cb(manager)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RsvpService,
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    service = module.get(RsvpService);
  });

  it('rejects RSVP on a non-published event', async () => {
    managerFindOne.mockResolvedValue({ id: 'e1', status: EventStatus.Draft });
    await expect(service.rsvp('e', 'u1', 'going')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('waitlists a going RSVP when capacity is full', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      capacity: 2,
    });
    rsvpRepo.count.mockResolvedValue(2); // full
    const result = await service.rsvp('e', 'u1', 'going');
    expect(result.status).toBe(RsvpStatus.Waitlisted);
    expect(result.waitlistPosition).toBe(1);
  });

  it('admits a going RSVP under capacity', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      capacity: 5,
    });
    rsvpRepo.count.mockResolvedValue(1);
    const result = await service.rsvp('e', 'u1', 'going');
    expect(result.status).toBe(RsvpStatus.Going);
  });

  it('keeps a waitlisted member at their position on a re-RSVP', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      capacity: 1,
    });
    rsvpRepo.count.mockResolvedValue(1); // still full
    rsvpRepo.findOne.mockResolvedValue({
      eventId: 'e1',
      userId: 'u1',
      status: RsvpStatus.Waitlisted,
      waitlistPosition: 3,
    });
    const result = await service.rsvp('e', 'u1', 'going');
    expect(result.status).toBe(RsvpStatus.Waitlisted);
    expect(result.waitlistPosition).toBe(3); // unchanged — not pushed to the back
    expect(rsvpRepo.save).not.toHaveBeenCalled();
  });

  it('promotes the waitlist head when a going RSVP steps down to maybe', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      capacity: 1,
    });
    rsvpRepo.count.mockResolvedValue(0);
    rsvpRepo.findOne
      .mockResolvedValueOnce({
        eventId: 'e1',
        userId: 'u1',
        status: RsvpStatus.Going,
      }) // existing (mine)
      .mockResolvedValueOnce({
        eventId: 'e1',
        userId: 'u2',
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 1,
      }); // waitlist head
    const result = await service.rsvp('e', 'u1', 'maybe');
    expect(result.status).toBe(RsvpStatus.Maybe);
    expect(emitter.emit).toHaveBeenCalledWith(
      'event.waitlist_promoted',
      expect.objectContaining({ eventId: 'e1', userId: 'u2' }),
    );
  });

  it('promotes the waitlist head and emits when a going RSVP cancels', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      capacity: 1,
    });
    rsvpRepo.findOne
      .mockResolvedValueOnce({
        eventId: 'e1',
        userId: 'u1',
        status: RsvpStatus.Going,
      }) // mine
      .mockResolvedValueOnce({
        eventId: 'e1',
        userId: 'u2',
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 1,
      }); // head
    await service.cancelRsvp('e', 'u1');
    expect(emitter.emit).toHaveBeenCalledWith(
      'event.waitlist_promoted',
      expect.objectContaining({ eventId: 'e1', userId: 'u2' }),
    );
  });

  it('does not promote when the event is not published', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Cancelled,
      capacity: 1,
    });
    rsvpRepo.findOne.mockResolvedValueOnce({
      eventId: 'e1',
      userId: 'u1',
      status: RsvpStatus.Going,
    }); // mine
    await service.cancelRsvp('e', 'u1');
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('reconcileWaitlist promotes only while seats remain (capacity-aware loop)', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      capacity: 2,
    });
    // goingCount rises 0 → 1 → 2 across iterations; stops once it hits capacity.
    rsvpRepo.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    rsvpRepo.findOne
      .mockResolvedValueOnce({
        eventId: 'e1',
        userId: 'h1',
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 1,
      })
      .mockResolvedValueOnce({
        eventId: 'e1',
        userId: 'h2',
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 2,
      });
    await service.reconcileWaitlist('e');
    expect(emitter.emit).toHaveBeenCalledTimes(2);
  });

  it('blocks an RSVP to an invite-only event from a non-invitee', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      visibility: EventVisibility.InviteOnly,
      hostId: 'host',
      capacity: null,
    });
    managerExists.mockResolvedValue(false); // not a co-host, not invited
    await expect(service.rsvp('e', 'stranger', 'going')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows an invited member to RSVP to an invite-only event', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      visibility: EventVisibility.InviteOnly,
      hostId: 'host',
      capacity: null,
    });
    managerExists
      .mockResolvedValueOnce(false) // co-host check
      .mockResolvedValueOnce(true); // invite check
    const result = await service.rsvp('e', 'invited', 'going');
    expect(result.status).toBe(RsvpStatus.Going);
  });
});

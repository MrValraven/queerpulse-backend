import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { RsvpStatus } from './entities/event-rsvp.entity';
import { EventStatus, EventVisibility } from './entities/event.entity';
import { RsvpService } from './rsvp.service';

describe('RsvpService', () => {
  let service: RsvpService;
  let managerFindOne: jest.Mock;
  let managerExists: jest.Mock;
  let rsvpRepo: {
    count: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  // One shared chainable builder stub covering BOTH query shapes the service
  // now runs through `createQueryBuilder`: the `select().where().getRawOne()`
  // MAX(waitlist_position) probe on the waitlist-add path, and the bulk
  // `update().set().where()[.andWhere().returning()].execute()` promotion in
  // `promoteWaitlist` (the per-attendee findOne/save loop is gone).
  let rsvpQueryBuilder: Record<string, jest.Mock>;
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    managerFindOne = jest.fn();
    managerExists = jest.fn().mockResolvedValue(false);
    rsvpQueryBuilder = {};
    for (const method of [
      'select',
      'update',
      'set',
      'where',
      'andWhere',
      'returning',
    ]) {
      rsvpQueryBuilder[method] = jest.fn().mockReturnValue(rsvpQueryBuilder);
    }
    // MAX(waitlist_position) probe → no one waitlisted yet.
    rsvpQueryBuilder.getRawOne = jest.fn().mockResolvedValue({ max: 0 });
    // Bulk UPDATE default: claims nobody (the finite path derives promoted ids
    // from `find()`, not from RETURNING, so this only matters for the
    // unlimited-capacity path).
    rsvpQueryBuilder.execute = jest.fn().mockResolvedValue({ raw: [] });
    rsvpRepo = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((rsvp: unknown) => rsvp),
      create: jest.fn((rsvp: unknown) => rsvp),
      createQueryBuilder: jest.fn(() => rsvpQueryBuilder),
    };
    emitter = { emit: jest.fn() };
    const manager = {
      getRepository: () => rsvpRepo,
      findOne: managerFindOne,
      exists: managerExists,
    };
    const dataSource = {
      transaction: jest.fn(
        (runInTransaction: (entityManager: unknown) => unknown) =>
          runInTransaction(manager),
      ),
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
    rsvpRepo.count.mockResolvedValue(0); // 0 going after the step-down → 1 seat free
    rsvpRepo.findOne.mockResolvedValueOnce({
      eventId: 'e1',
      userId: 'u1',
      status: RsvpStatus.Going,
    }); // existing (mine)
    // The freed seat's promotion now comes from ONE bulk `find` of the waitlist
    // head(s), not a per-attendee `findOne`.
    rsvpRepo.find.mockResolvedValue([
      {
        id: 'w2',
        eventId: 'e1',
        userId: 'u2',
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 1,
      },
    ]);
    const result = await service.rsvp('e', 'u1', 'maybe');
    expect(result.status).toBe(RsvpStatus.Maybe);
    // Seat-bounded: exactly the one freed seat is filled from the waitlist head.
    expect(rsvpRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: RsvpStatus.Waitlisted }),
        take: 1,
      }),
    );
    // Promotion is a single bulk UPDATE, not a save() per promoted attendee.
    expect(rsvpQueryBuilder.update).toHaveBeenCalled();
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
    rsvpRepo.findOne.mockResolvedValueOnce({
      eventId: 'e1',
      userId: 'u1',
      status: RsvpStatus.Going,
    }); // mine
    // Cancelling a going seat frees one; the waitlist head is pulled up via the
    // bulk `find` + UPDATE (was a findOne/save per promotion).
    rsvpRepo.find.mockResolvedValue([
      {
        id: 'w2',
        eventId: 'e1',
        userId: 'u2',
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 1,
      },
    ]);
    await service.cancelRsvp('e', 'u1');
    expect(rsvpQueryBuilder.update).toHaveBeenCalled();
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

  it('reconcileWaitlist promotes only up to the free seats (capacity-aware bulk promote)', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      capacity: 2,
    });
    // 0 going against a capacity of 2 → exactly 2 free seats. The promotion is
    // now one seat-bounded `find(take: freeSeats)` + one bulk UPDATE, not a
    // count/findOne/save loop per seat.
    rsvpRepo.count.mockResolvedValue(0);
    rsvpRepo.find.mockResolvedValue([
      {
        id: 'w1',
        eventId: 'e1',
        userId: 'h1',
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 1,
      },
      {
        id: 'w2',
        eventId: 'e1',
        userId: 'h2',
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 2,
      },
    ]);
    await service.reconcileWaitlist('e');
    // The `find` is bounded to the free seats (2), earliest waiters first...
    expect(rsvpRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: RsvpStatus.Waitlisted }),
        order: { waitlistPosition: 'ASC' },
        take: 2,
      }),
    );
    // ...and both freed seats are promoted in a single bulk UPDATE.
    expect(rsvpQueryBuilder.update).toHaveBeenCalledTimes(1);
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

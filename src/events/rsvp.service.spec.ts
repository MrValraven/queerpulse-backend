import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { EventAudienceGateService } from './event-audience-gate.service';
import { EventCapacityAlertsService } from './event-capacity-alerts.service';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus, EventVisibility } from './entities/event.entity';
import { RsvpService } from './rsvp.service';

describe('RsvpService', () => {
  let service: RsvpService;
  let managerFindOne: jest.Mock;
  let managerExists: jest.Mock;
  // `assertMayRsvp` now delegates the actual audience-scope tier decision to
  // the shared gate (see `EventAudienceGateService`) — defaults to "allow"
  // (matches every non-invite_only fixture below, none of which set
  // `visibility`); the two invite-only tests override this per-case.
  let audienceGate: { assertViewable: jest.Mock };
  // LOC-08: `assertMayRsvp` refuses a member who has blocked, or been blocked
  // by, the host. Defaults to "no block" so the capacity/waitlist cases below
  // exercise their own rule; the block rule itself is covered where it is
  // asserted.
  let blockFilter: { isBlockedEitherWay: jest.Mock };
  // PRD-18 "last few spots". Fired post-commit whenever a seat is taken or
  // freed; swallows its own failures, so the tests only need it to exist.
  let capacityAlerts: { onSeatsChanged: jest.Mock };
  let rsvpRepo: {
    count: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  // One shared chainable builder stub covering the three query shapes the
  // service now runs through `createQueryBuilder`: the
  // `COUNT(*) + SUM(guest_count)` seat probe (LOC-07 counts SEATS, not rows,
  // so capacity no longer comes from `rsvpRepo.count`), the
  // MAX(waitlist_position) probe on the waitlist-add path, and the bulk
  // `update().set().where()[.andWhere().returning()].execute()` promotion in
  // `promoteWaitlist` (the per-attendee findOne/save loop is gone).
  let rsvpQueryBuilder: Record<string, jest.Mock>;
  // Drives the two raw probes above. `getRawOne` answers whichever one the
  // last `select()` alias asked for, so a test just sets the number it means.
  let goingSeats: number;
  let maxWaitlistPosition: number;
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    managerFindOne = jest.fn();
    managerExists = jest.fn().mockResolvedValue(false);
    goingSeats = 0;
    maxWaitlistPosition = 0;
    rsvpQueryBuilder = {};
    for (const method of ['update', 'set', 'where', 'andWhere', 'returning']) {
      rsvpQueryBuilder[method] = jest.fn().mockReturnValue(rsvpQueryBuilder);
    }
    let lastSelectAlias = '';
    rsvpQueryBuilder.select = jest.fn(
      (_expression: string, alias: string): unknown => {
        lastSelectAlias = alias;
        return rsvpQueryBuilder;
      },
    );
    // Seat probe (`'seats'`) → occupied seats, guests included. Waitlist probe
    // (`'max'`) → the highest waitlist position handed out so far.
    rsvpQueryBuilder.getRawOne = jest.fn(() =>
      Promise.resolve(
        lastSelectAlias === 'seats'
          ? { seats: String(goingSeats) }
          : { max: maxWaitlistPosition },
      ),
    );
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
    audienceGate = {
      assertViewable: jest.fn().mockResolvedValue(undefined),
    };
    blockFilter = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
    };
    capacityAlerts = {
      onSeatsChanged: jest.fn().mockResolvedValue(undefined),
    };
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
        { provide: EventAudienceGateService, useValue: audienceGate },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: EventCapacityAlertsService, useValue: capacityAlerts },
        // `removeAttendee`/`promoteAttendee`/`updateRsvpDetails` (P1-9/MSG-5)
        // read these two directly (not through `dataSource.transaction`'s
        // manager) — unused by the tests below, which only exercise
        // `rsvp`/`cancelRsvp`/`reconcileWaitlist`, but required for the
        // module to compile/resolve.
        { provide: getRepositoryToken(Profile), useValue: {} },
        { provide: getRepositoryToken(Event), useValue: {} },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvpRepo },
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
    goingSeats = 2; // full
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
    goingSeats = 1;
    const result = await service.rsvp('e', 'u1', 'going');
    expect(result.status).toBe(RsvpStatus.Going);
  });

  it('keeps a waitlisted member at their position on a re-RSVP', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      capacity: 1,
    });
    goingSeats = 1; // still full
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
    goingSeats = 0; // 0 going after the step-down → 1 seat free
    // Not `...Once`: `assertMayRsvp` reads this same row first (the LOC-08
    // "removed by the host?" check), so the member's live row has to answer
    // both lookups the way the database would.
    rsvpRepo.findOne.mockResolvedValue({
      eventId: 'e1',
      userId: 'u1',
      status: RsvpStatus.Going,
    }); // existing (mine)
    // The freed seat's promotion now comes from ONE bulk `find` of the
    // waitlist in queue order, not a per-attendee `findOne`. Two are waiting
    // for the single freed seat.
    rsvpRepo.find.mockResolvedValue([
      {
        id: 'w2',
        eventId: 'e1',
        userId: 'u2',
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 1,
        guestCount: 0,
      },
      {
        id: 'w3',
        eventId: 'e1',
        userId: 'u3',
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 2,
        guestCount: 0,
      },
    ]);
    const result = await service.rsvp('e', 'u1', 'maybe');
    expect(result.status).toBe(RsvpStatus.Maybe);
    // The whole waitlist is read in queue order; the seat bound is applied to
    // the rows (LOC-07 — a party's guests count, so how many rows fit is not
    // knowable from a `take`).
    expect(rsvpRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: RsvpStatus.Waitlisted,
        }) as Partial<EventRsvp>,
        order: { waitlistPosition: 'ASC' },
      }),
    );
    // Promotion is a single bulk UPDATE, not a save() per promoted attendee.
    expect(rsvpQueryBuilder.update).toHaveBeenCalled();
    // Seat-bounded: exactly the one freed seat is filled, by the head of the
    // queue. The member behind them stays waiting.
    expect(emitter.emit).toHaveBeenCalledTimes(1);
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
        guestCount: 0,
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
    // 0 seats taken against a capacity of 2 → exactly 2 free seats, with three
    // members waiting. The promotion is one ordered `find` + one bulk UPDATE,
    // not a count/findOne/save loop per seat.
    goingSeats = 0;
    rsvpRepo.find.mockResolvedValue([
      {
        id: 'w1',
        eventId: 'e1',
        userId: 'h1',
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 1,
        guestCount: 0,
      },
      {
        id: 'w2',
        eventId: 'e1',
        userId: 'h2',
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 2,
        guestCount: 0,
      },
      {
        id: 'w3',
        eventId: 'e1',
        userId: 'h3',
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 3,
        guestCount: 0,
      },
    ]);
    await service.reconcileWaitlist('e');
    // The waitlist is read whole, earliest waiters first...
    expect(rsvpRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: RsvpStatus.Waitlisted,
        }) as Partial<EventRsvp>,
        order: { waitlistPosition: 'ASC' },
      }),
    );
    // ...and exactly the two free seats are promoted, in a single bulk UPDATE.
    // The third waiter is left where they are: capacity is never overrun.
    expect(rsvpQueryBuilder.update).toHaveBeenCalledTimes(1);
    expect(emitter.emit).toHaveBeenCalledTimes(2);
    expect(emitter.emit).not.toHaveBeenCalledWith(
      'event.waitlist_promoted',
      expect.objectContaining({ userId: 'h3' }),
    );
  });

  // Both tests below cover `RsvpService`'s OWN responsibility post-fix-round-1:
  // computing `isOrganizer` (host id, or a co-host row via `manager` — the
  // transaction-scoped check that predates the shared gate) and handing it to
  // `EventAudienceGateService.assertViewable`, then propagating whatever it
  // does. The tier decision itself (invited vs. not) is `EventAudienceGateService`'s
  // own unit-tested responsibility, not re-tested here — these mock it.
  it('blocks an RSVP the shared audience gate rejects (e.g. invite-only, not invited)', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      visibility: EventVisibility.InviteOnly,
      hostId: 'host',
      capacity: null,
    });
    managerExists.mockResolvedValue(false); // not a co-host
    // Same exception shape `assertCanView` uses — existence is never leaked,
    // regardless of which tier rejected the viewer.
    audienceGate.assertViewable.mockRejectedValue(
      new NotFoundException('Event not found'),
    );
    await expect(service.rsvp('e', 'stranger', 'going')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audienceGate.assertViewable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1' }),
      'stranger',
      false, // not the host, not a co-host
    );
  });

  it('allows an RSVP the shared audience gate admits (e.g. an invited member)', async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      visibility: EventVisibility.InviteOnly,
      hostId: 'host',
      capacity: null,
    });
    managerExists.mockResolvedValue(false); // not a co-host
    audienceGate.assertViewable.mockResolvedValue(undefined); // gate admits (e.g. invited)
    const result = await service.rsvp('e', 'invited', 'going');
    expect(result.status).toBe(RsvpStatus.Going);
    expect(audienceGate.assertViewable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1' }),
      'invited',
      false,
    );
  });

  it("computes isOrganizer=true for the host without asking the gate to check any tier's membership", async () => {
    managerFindOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
      visibility: EventVisibility.Network,
      hostId: 'host',
      capacity: null,
    });
    const result = await service.rsvp('e', 'host', 'going');
    expect(result.status).toBe(RsvpStatus.Going);
    // The host never needs a co-host lookup — `isOrganizer` short-circuits on
    // `event.hostId === userId` before `manager.exists` would even matter.
    expect(audienceGate.assertViewable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1' }),
      'host',
      true,
    );
  });
});

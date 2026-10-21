import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { Profile } from '../users/entities/profile.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { EventAudienceGateService } from './event-audience-gate.service';
import { EventCapacityAlertsService } from './event-capacity-alerts.service';
import {
  EventInvite,
  EventInviteSource,
  EventInviteStatus,
} from './entities/event-invite.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus, EventVisibility } from './entities/event.entity';
import { EVENT_INVITE_ACCEPTED } from './event.events';
import {
  RSVP_GUEST_CAP_MESSAGE,
  RSVPS_CLOSED_MESSAGE,
} from './gathering-extras';
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
    update: jest.Mock;
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
  // `updateRsvpDetails` loads the event through the plain `Event` repository
  // to decide whether an edit could be a guest-count raise, outside any
  // transaction. A raise re-reads the same event through `managerFindOne`
  // under the `pessimistic_write` lock (ENG-431): see
  // `raiseGuestCountAndSave`.
  let eventRepo: { findOne: jest.Mock };
  // `removeAttendee` resolves the target member's slug to a user id here.
  let profileRepo: { findOne: jest.Mock };
  // The invite writes (auto-accept on RSVP, withdraw on cancel or removal)
  // run as `manager.createQueryBuilder().update(EventInvite)...execute()`.
  // A builder of their own keeps them apart from the RSVP probes above.
  let managerQueryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    returning: jest.Mock;
    execute: jest.Mock;
  };
  // Spec decision 7: a `connections` accept reaches the inviter only while
  // the two are still connected.
  let connectionsService: { areConnected: jest.Mock };
  let managerUpdate: jest.Mock;
  // The guest cap's count of the inviter's open member invites.
  let managerCount: jest.Mock;
  let dataSourceTransaction: jest.Mock;

  beforeEach(async () => {
    managerFindOne = jest.fn();
    managerExists = jest.fn().mockResolvedValue(false);
    profileRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const chainStep = (): jest.Mock => jest.fn(() => managerQueryBuilder);
    managerQueryBuilder = {
      update: chainStep(),
      set: chainStep(),
      where: chainStep(),
      andWhere: chainStep(),
      returning: chainStep(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    connectionsService = { areConnected: jest.fn().mockResolvedValue(true) };
    managerUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    managerCount = jest.fn().mockResolvedValue(0);
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
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      create: jest.fn((rsvp: unknown) => rsvp),
      createQueryBuilder: jest.fn(() => rsvpQueryBuilder),
    };
    emitter = { emit: jest.fn() };
    eventRepo = { findOne: jest.fn().mockResolvedValue(null) };
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
      createQueryBuilder: jest.fn(() => managerQueryBuilder),
      update: managerUpdate,
      count: managerCount,
    };
    dataSourceTransaction = jest.fn(
      (runInTransaction: (entityManager: unknown) => unknown) =>
        runInTransaction(manager),
    );
    const dataSource = {
      transaction: dataSourceTransaction,
      // `updateRsvpDetails` takes no lock, so its organiser lookup reads
      // through the plain data-source manager. The same stub answers it, so
      // `managerExists` drives the co-host answer on both paths.
      manager,
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RsvpService,
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: emitter },
        { provide: EventAudienceGateService, useValue: audienceGate },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: EventCapacityAlertsService, useValue: capacityAlerts },
        { provide: ConnectionsService, useValue: connectionsService },
        // `removeAttendee`/`promoteAttendee`/`updateRsvpDetails` (P1-9/MSG-5)
        // read these directly, outside `dataSource.transaction`'s manager.
        { provide: getRepositoryToken(Profile), useValue: profileRepo },
        { provide: getRepositoryToken(Event), useValue: eventRepo },
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

  // The host's RSVP cutoff (create-gathering v2). Past it nobody new joins
  // the roster, while stepping down, cancelling and organiser actions stay
  // open.
  describe('RSVP cutoff', () => {
    const HOUR_IN_MILLISECONDS = 60 * 60 * 1000;
    const CLOSED_MESSAGE = 'RSVPs for this event have closed';
    // Starts in two hours with a day-before cutoff, so RSVPs closed 22 hours
    // ago. Unlimited capacity keeps the seat arithmetic out of the way.
    const closedEvent = () => ({
      id: 'e1',
      slug: 'e',
      hostId: 'host-1',
      status: EventStatus.Published,
      capacity: null,
      startAt: new Date(Date.now() + 2 * HOUR_IN_MILLISECONDS),
      endAt: null,
      rsvpCutoff: 'day-before' as const,
    });
    const existingRsvp = (status: RsvpStatus) => ({
      id: 'r1',
      eventId: 'e1',
      userId: 'u1',
      status,
      waitlistPosition: null,
      guestCount: 0,
      removedByHostAt: null,
      checkedInAt: null,
    });

    it('refuses a first RSVP once the cutoff has passed', async () => {
      managerFindOne.mockResolvedValue(closedEvent());
      const attempt = service.rsvp('e', 'u1', 'going');
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(CLOSED_MESSAGE);
      expect(rsvpRepo.save).not.toHaveBeenCalled();
    });

    it('refuses a first maybe once the cutoff has passed', async () => {
      managerFindOne.mockResolvedValue(closedEvent());
      await expect(service.rsvp('e', 'u1', 'maybe')).rejects.toThrow(
        CLOSED_MESSAGE,
      );
    });

    it('refuses to revive a cancelled RSVP past the cutoff', async () => {
      managerFindOne.mockResolvedValue(closedEvent());
      rsvpRepo.findOne.mockResolvedValue(existingRsvp(RsvpStatus.Cancelled));
      await expect(service.rsvp('e', 'u1', 'going')).rejects.toThrow(
        CLOSED_MESSAGE,
      );
      expect(rsvpRepo.save).not.toHaveBeenCalled();
    });

    it('refuses a maybe stepping up to going past the cutoff', async () => {
      managerFindOne.mockResolvedValue(closedEvent());
      rsvpRepo.findOne.mockResolvedValue(existingRsvp(RsvpStatus.Maybe));
      await expect(service.rsvp('e', 'u1', 'going')).rejects.toThrow(
        CLOSED_MESSAGE,
      );
    });

    it('refuses a waitlisted member stepping up to going past the cutoff', async () => {
      managerFindOne.mockResolvedValue(closedEvent());
      rsvpRepo.findOne.mockResolvedValue(existingRsvp(RsvpStatus.Waitlisted));
      await expect(service.rsvp('e', 'u1', 'going')).rejects.toThrow(
        CLOSED_MESSAGE,
      );
      expect(rsvpRepo.save).not.toHaveBeenCalled();
    });

    it('lets a going member step down to maybe past the cutoff', async () => {
      managerFindOne.mockResolvedValue(closedEvent());
      rsvpRepo.findOne.mockResolvedValue(existingRsvp(RsvpStatus.Going));
      const result = await service.rsvp('e', 'u1', 'maybe');
      expect(result.status).toBe(RsvpStatus.Maybe);
    });

    it('lets an organiser RSVP to their own gathering past the cutoff', async () => {
      managerFindOne.mockResolvedValue(closedEvent());
      const result = await service.rsvp('e', 'host-1', 'going');
      expect(result.status).toBe(RsvpStatus.Going);
    });

    it('admits a first RSVP while the cutoff is still ahead', async () => {
      managerFindOne.mockResolvedValue({
        ...closedEvent(),
        startAt: new Date(Date.now() + 72 * HOUR_IN_MILLISECONDS),
      });
      const result = await service.rsvp('e', 'u1', 'going');
      expect(result.status).toBe(RsvpStatus.Going);
    });

    it('lets a member cancel past the cutoff', async () => {
      managerFindOne.mockResolvedValue(closedEvent());
      rsvpRepo.findOne.mockResolvedValue(existingRsvp(RsvpStatus.Going));
      await expect(service.cancelRsvp('e', 'u1')).resolves.toEqual({
        ok: true,
      });
      expect(rsvpRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: RsvpStatus.Cancelled }),
      );
    });
  });

  describe('updateRsvpDetails question answers', () => {
    const goingRsvp = () => ({
      id: 'r1',
      eventId: 'e1',
      userId: 'u1',
      status: RsvpStatus.Going,
      guestCount: 0,
      accessNeeds: null,
      dietaryNeeds: null,
      visibility: null,
      pronouns: 'she/her',
      customAnswer: 'Bringing a friend',
    });

    beforeEach(() => {
      eventRepo.findOne.mockResolvedValue({ id: 'e1', capacity: null });
    });

    it('trims the pronouns and stores a blank custom answer as null', async () => {
      rsvpRepo.findOne.mockResolvedValue(goingRsvp());
      const view = await service.updateRsvpDetails('e', 'u1', {
        pronouns: '  they/them  ',
        customAnswer: '   ',
      });
      expect(view.pronouns).toBe('they/them');
      expect(view.customAnswer).toBeNull();
    });

    it('leaves an answer alone when the patch does not mention it', async () => {
      rsvpRepo.findOne.mockResolvedValue(goingRsvp());
      const view = await service.updateRsvpDetails('e', 'u1', {
        guestCount: 0,
      });
      expect(view.pronouns).toBe('she/her');
      expect(view.customAnswer).toBe('Bringing a friend');
    });

    // M4: the unlocked path writes the edited columns alone, so a status,
    // waitlist position or guest count committed by a promotion or a locked
    // raise after the plain read keeps its committed value.
    it('writes only the edited columns on the unlocked path', async () => {
      rsvpRepo.findOne.mockResolvedValue(goingRsvp());
      const view = await service.updateRsvpDetails('e', 'u1', {
        pronouns: '  they/them  ',
      });
      expect(rsvpRepo.update).toHaveBeenCalledWith(
        { id: 'r1' },
        { pronouns: 'they/them' },
      );
      expect(rsvpRepo.save).not.toHaveBeenCalled();
      expect(view.pronouns).toBe('they/them');
      expect(view.customAnswer).toBe('Bringing a friend');
    });

    it('writes nothing for an edit that names no field', async () => {
      rsvpRepo.findOne.mockResolvedValue(goingRsvp());
      const view = await service.updateRsvpDetails('e', 'u1', {});
      expect(rsvpRepo.update).not.toHaveBeenCalled();
      expect(rsvpRepo.save).not.toHaveBeenCalled();
      expect(view.pronouns).toBe('she/her');
    });
  });

  // Past the host's RSVP cutoff a member can still lower their guest count
  // and change every other answer; a raise gets the closed 400. Organisers
  // keep raising, as they keep RSVPing.
  describe('updateRsvpDetails guest count after the RSVP cutoff', () => {
    const HOUR_IN_MILLISECONDS = 60 * 60 * 1000;
    const CLOSED_MESSAGE = 'RSVPs for this event have closed';
    // Starts in two hours with a day-before cutoff, so RSVPs closed 22 hours
    // ago. Unlimited capacity keeps the seat arithmetic out of the way.
    const closedEvent = () => ({
      id: 'e1',
      slug: 'e',
      hostId: 'host-1',
      status: EventStatus.Published,
      capacity: null,
      startAt: new Date(Date.now() + 2 * HOUR_IN_MILLISECONDS),
      endAt: null,
      rsvpCutoff: 'day-before' as const,
    });
    const goingRsvp = (userId: string, guestCount: number) => ({
      id: 'r1',
      eventId: 'e1',
      userId,
      status: RsvpStatus.Going,
      guestCount,
      accessNeeds: null,
      dietaryNeeds: null,
      visibility: null,
      pronouns: null,
      customAnswer: null,
    });

    beforeEach(() => {
      eventRepo.findOne.mockResolvedValue(closedEvent());
      // A raise re-reads the event under lock via `manager.findOne`
      // (ENG-431), same fixture, since these are not testing a race.
      managerFindOne.mockResolvedValue(closedEvent());
    });

    it('refuses a member raising their guest count', async () => {
      rsvpRepo.findOne.mockResolvedValue(goingRsvp('u1', 1));
      const attempt = service.updateRsvpDetails('e', 'u1', { guestCount: 2 });
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(CLOSED_MESSAGE);
      expect(rsvpRepo.save).not.toHaveBeenCalled();
    });

    it('lets a member lower their guest count', async () => {
      rsvpRepo.findOne.mockResolvedValue(goingRsvp('u1', 2));
      const view = await service.updateRsvpDetails('e', 'u1', {
        guestCount: 1,
      });
      expect(view.guestCount).toBe(1);
    });

    it('lets the host raise their own guest count without a co-host lookup', async () => {
      rsvpRepo.findOne.mockResolvedValue(goingRsvp('host-1', 0));
      const view = await service.updateRsvpDetails('e', 'host-1', {
        guestCount: 3,
      });
      expect(view.guestCount).toBe(3);
      expect(managerExists).not.toHaveBeenCalled();
    });

    it('lets a co-host raise their guest count', async () => {
      managerExists.mockResolvedValue(true);
      rsvpRepo.findOne.mockResolvedValue(goingRsvp('cohost-1', 0));
      const view = await service.updateRsvpDetails('e', 'cohost-1', {
        guestCount: 1,
      });
      expect(view.guestCount).toBe(1);
    });

    it('keeps every other answer editable for a member', async () => {
      rsvpRepo.findOne.mockResolvedValue(goingRsvp('u1', 1));
      const view = await service.updateRsvpDetails('e', 'u1', {
        guestCount: 1,
        accessNeeds: 'A step-free way in, please',
        pronouns: '  they/them  ',
        customAnswer: 'Bringing bread',
      });
      expect(view).toEqual(
        expect.objectContaining({
          guestCount: 1,
          accessNeeds: 'A step-free way in, please',
          pronouns: 'they/them',
          customAnswer: 'Bringing bread',
        }),
      );
      // An unchanged count is no raise, so nobody is asked who organises.
      expect(managerExists).not.toHaveBeenCalled();
    });
  });

  // ENG-431: a guest-count raise used to check capacity with plain reads
  // outside any lock, so two concurrent raises, or a raise racing a fresh
  // RSVP, could each read the same "seats free" snapshot and both pass. A
  // raise now runs inside `dataSource.transaction` and re-reads the event
  // through `manager.findOne` with the same `pessimistic_write` lock `rsvp()`
  // takes, exactly like the create path's lock (asserted the same way the
  // `rsvp()`/`cancelRsvp()` tests above check `managerFindOne`'s call shape).
  describe('updateRsvpDetails guest-count raise takes the event lock (ENG-431)', () => {
    const openEvent = (capacity: number | null) => ({
      id: 'e1',
      slug: 'e',
      hostId: 'host-1',
      status: EventStatus.Published,
      capacity,
      startAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      endAt: null,
      rsvpCutoff: 'day-before' as const,
    });
    const goingRsvp = (guestCount: number) => ({
      id: 'r1',
      eventId: 'e1',
      userId: 'u1',
      status: RsvpStatus.Going,
      guestCount,
      accessNeeds: null,
      dietaryNeeds: null,
      visibility: null,
      pronouns: null,
      customAnswer: null,
    });

    it('acquires the same pessimistic_write event lock the RSVP create path takes', async () => {
      eventRepo.findOne.mockResolvedValue(openEvent(5));
      managerFindOne.mockResolvedValue(openEvent(5));
      rsvpRepo.findOne.mockResolvedValue(goingRsvp(0));
      goingSeats = 1; // just the caller's own current seat
      await service.updateRsvpDetails('e', 'u1', { guestCount: 1 });
      expect(managerFindOne).toHaveBeenCalledWith(
        Event,
        expect.objectContaining({
          where: { slug: 'e' },
          lock: { mode: 'pessimistic_write' },
        }),
      );
    });

    it('rejects a raise that would push the event over capacity', async () => {
      eventRepo.findOne.mockResolvedValue(openEvent(2));
      managerFindOne.mockResolvedValue(openEvent(2));
      rsvpRepo.findOne.mockResolvedValue(goingRsvp(0));
      goingSeats = 2; // already full, including the caller's own single seat
      const attempt = service.updateRsvpDetails('e', 'u1', { guestCount: 1 });
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(
        'There is not enough room left for that many guests',
      );
      expect(rsvpRepo.save).not.toHaveBeenCalled();
    });

    it('admits a raise that still fits under capacity', async () => {
      eventRepo.findOne.mockResolvedValue(openEvent(5));
      managerFindOne.mockResolvedValue(openEvent(5));
      rsvpRepo.findOne.mockResolvedValue(goingRsvp(0));
      goingSeats = 2;
      const view = await service.updateRsvpDetails('e', 'u1', {
        guestCount: 1,
      });
      expect(view.guestCount).toBe(1);
    });

    // Fix round 1: the test harness's `manager.getRepository()` returns the
    // exact same mock the plain injected `EventRsvp` repo uses, so a test that
    // sets one `rsvpRepo.findOne` answer for both reads cannot tell the
    // locked path's fresh re-read apart from the caller's stale outer
    // pre-check. `mockResolvedValueOnce` sequences two different rows onto
    // the two calls the code actually makes (outer, unlocked, then the
    // locked re-read inside `raiseGuestCountAndSave`), so the capacity math
    // below can only come out right if it used the SECOND row.
    it('bases the capacity decision on the fresh row read under the lock', async () => {
      eventRepo.findOne.mockResolvedValue(openEvent(3));
      managerFindOne.mockResolvedValue(openEvent(3));
      // Outer pre-check: a stale guestCount of 0, as if this caller's own
      // earlier read raced a concurrent raise that already committed.
      // Locked re-read: the row as it actually stands now, guestCount 1.
      rsvpRepo.findOne
        .mockResolvedValueOnce(goingRsvp(0))
        .mockResolvedValueOnce(goingRsvp(1));
      goingSeats = 2;
      // Raising to 2 guests: against the STALE row (0) extraSeats would be 2,
      // and 2 + 2 = 4 > 3 would reject. Against the FRESH row (1) extraSeats
      // is only 1, and 2 + 1 = 3 fits exactly. Succeeding here is only
      // possible if the fresh, locked read drove the decision.
      const view = await service.updateRsvpDetails('e', 'u1', {
        guestCount: 2,
      });
      expect(view.guestCount).toBe(2);
    });

    it('never locks or checks capacity for a lowered guest count', async () => {
      eventRepo.findOne.mockResolvedValue(openEvent(1));
      rsvpRepo.findOne.mockResolvedValue(goingRsvp(2));
      const view = await service.updateRsvpDetails('e', 'u1', {
        guestCount: 1,
      });
      expect(view.guestCount).toBe(1);
      expect(managerFindOne).not.toHaveBeenCalled();
    });
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

  // Member invites to an event. An invitee who RSVPs from the event page
  // answers their pending invite, accepting from an invite writes the RSVP
  // and its details together, a member who leaves takes their open invites
  // with them, and the guest cap counts open invites on a raise.
  describe('member invites', () => {
    const HOUR_IN_MILLISECONDS = 60 * 60 * 1000;
    const openEvent = (overrides: Record<string, unknown> = {}) => ({
      id: 'e1',
      slug: 'e',
      hostId: 'host-1',
      title: 'Picnic',
      visibility: EventVisibility.InviteOnly,
      status: EventStatus.Published,
      capacity: null as number | null,
      allowWaitlist: true,
      startAt: new Date(Date.now() + 72 * HOUR_IN_MILLISECONDS),
      endAt: null,
      rsvpCutoff: 'day-before' as const,
      ...overrides,
    });
    const invite = (status: EventInviteStatus) => ({
      id: 'i1',
      eventId: 'e1',
      inviterId: 'u2',
      inviteeId: 'u1',
      status,
      source: EventInviteSource.Member,
    });
    // One `managerFindOne` answers both the locked event read and the
    // invite re-read inside `acceptInviteRsvp`, keyed on the entity asked for.
    const answerReads = (
      event: ReturnType<typeof openEvent>,
      inviteRow: ReturnType<typeof invite> | null,
    ) => {
      managerFindOne.mockImplementation((entity: unknown) =>
        Promise.resolve(
          entity === Event ? event : entity === EventInvite ? inviteRow : null,
        ),
      );
    };
    const goingRsvp = (userId: string, guestCount: number) => ({
      id: 'r1',
      eventId: 'e1',
      userId,
      status: RsvpStatus.Going,
      guestCount,
      waitlistPosition: null,
      removedByHostAt: null,
      checkedInAt: null,
      accessNeeds: null,
      dietaryNeeds: null,
      visibility: null,
      pronouns: null,
      customAnswer: null,
    });

    const expectOpenMemberInvitesWithdrawn = (inviterId: string) => {
      expect(managerQueryBuilder.update).toHaveBeenCalledWith(EventInvite);
      expect(managerQueryBuilder.set).toHaveBeenCalledWith({
        status: 'withdrawn',
      });
      expect(managerQueryBuilder.where).toHaveBeenCalledWith(
        'event_id = :eventId',
        { eventId: 'e1' },
      );
      expect(managerQueryBuilder.andWhere).toHaveBeenCalledWith(
        'inviter_id = :inviterId',
        { inviterId },
      );
      expect(managerQueryBuilder.andWhere).toHaveBeenCalledWith(
        'source = :member',
        { member: 'member' },
      );
      expect(managerQueryBuilder.andWhere).toHaveBeenCalledWith(
        'status IN (:...openStatuses)',
        { openStatuses: ['pending', 'awaiting_host'] },
      );
      expect(managerQueryBuilder.execute).toHaveBeenCalled();
      expect(dataSourceTransaction).toHaveBeenCalledTimes(1);
      // Written after the RSVP row, inside the same transaction. A missing
      // save defaults to infinity, so the comparison fails when it is absent.
      const [withdrawOrder = 0] =
        managerQueryBuilder.execute.mock.invocationCallOrder;
      const [saveOrder = Number.POSITIVE_INFINITY] =
        rsvpRepo.save.mock.invocationCallOrder;
      expect(withdrawOrder).toBeGreaterThan(saveOrder);
    };

    it("rsvp marks the caller's pending invite to this event accepted", async () => {
      answerReads(openEvent(), null);
      const result = await service.rsvp('e', 'u1', 'going');
      expect(result.status).toBe(RsvpStatus.Going);
      expect(managerQueryBuilder.update).toHaveBeenCalledWith(EventInvite);
      expect(managerQueryBuilder.set).toHaveBeenCalledWith({
        status: 'accepted',
      });
      expect(managerQueryBuilder.where).toHaveBeenCalledWith(
        'event_id = :eventId',
        { eventId: 'e1' },
      );
      expect(managerQueryBuilder.andWhere).toHaveBeenCalledWith(
        'invitee_id = :inviteeId',
        { inviteeId: 'u1' },
      );
      expect(managerQueryBuilder.andWhere).toHaveBeenCalledWith(
        'status = :pending',
        { pending: 'pending' },
      );
      expect(managerQueryBuilder.execute).toHaveBeenCalled();
    });

    it('acceptInviteRsvp writes the details in the same transaction as the RSVP', async () => {
      answerReads(openEvent(), invite(EventInviteStatus.Accepted));
      const result = await service.acceptInviteRsvp('e', 'u1', 'i1', {
        visibility: 'justMe',
        accessNeeds: 'step-free',
      });
      expect(dataSourceTransaction).toHaveBeenCalledTimes(1);
      expect(managerUpdate).toHaveBeenCalledWith(
        EventRsvp,
        { eventId: 'e1', userId: 'u1' },
        { visibility: 'justMe', accessNeeds: 'step-free' },
      );
      expect(result).toEqual({ status: 'going', waitlistPosition: null });
    });

    it('acceptInviteRsvp throws Conflict when the invite is no longer pending', async () => {
      answerReads(openEvent(), invite(EventInviteStatus.Withdrawn));
      await expect(
        service.acceptInviteRsvp('e', 'u1', 'i1', { visibility: 'everyone' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(managerUpdate).not.toHaveBeenCalledWith(
        EventRsvp,
        expect.anything(),
        expect.anything(),
      );
    });

    it('acceptInviteRsvp waitlists on a full event', async () => {
      answerReads(
        openEvent({ capacity: 2 }),
        invite(EventInviteStatus.Accepted),
      );
      goingSeats = 2;
      const result = await service.acceptInviteRsvp('e', 'u1', 'i1', {
        visibility: 'everyone',
      });
      expect(result.status).toBe('waitlisted');
    });

    it('acceptInviteRsvp refuses a full event without a waitlist', async () => {
      answerReads(
        openEvent({ capacity: 2, allowWaitlist: false }),
        invite(EventInviteStatus.Accepted),
      );
      goingSeats = 2;
      const attempt = service.acceptInviteRsvp('e', 'u1', 'i1', {
        visibility: 'everyone',
      });
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow('This event is full');
    });

    it('acceptInviteRsvp refuses after the cutoff', async () => {
      answerReads(
        openEvent({ startAt: new Date(Date.now() + 2 * HOUR_IN_MILLISECONDS) }),
        invite(EventInviteStatus.Accepted),
      );
      await expect(
        service.acceptInviteRsvp('e', 'u1', 'i1', { visibility: 'everyone' }),
      ).rejects.toThrow(RSVPS_CLOSED_MESSAGE);
    });

    // The invite auto-accept's RETURNING rows: the invite a direct RSVP or an
    // accept just flipped, as Postgres names the columns.
    const acceptedInviteRows = (source: EventInviteSource) => {
      managerQueryBuilder.execute.mockResolvedValueOnce({
        affected: 1,
        raw: [{ id: 'i1', inviter_id: 'u2', source }],
      });
    };
    const inviteAcceptedPayload = {
      eventId: 'e1',
      eventSlug: 'e',
      eventTitle: 'Picnic',
      inviteId: 'i1',
      inviterId: 'u2',
      inviteeId: 'u1',
    };

    it('acceptInviteRsvp tells the member inviter when visibility is everyone', async () => {
      answerReads(openEvent(), invite(EventInviteStatus.Accepted));
      acceptedInviteRows(EventInviteSource.Member);
      await service.acceptInviteRsvp('e', 'u1', 'i1', {
        visibility: 'everyone',
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_INVITE_ACCEPTED,
        inviteAcceptedPayload,
      );
      expect(connectionsService.areConnected).not.toHaveBeenCalled();
    });

    it('acceptInviteRsvp tells a still-connected inviter under connections visibility', async () => {
      answerReads(openEvent(), invite(EventInviteStatus.Accepted));
      acceptedInviteRows(EventInviteSource.Member);
      connectionsService.areConnected.mockResolvedValue(true);
      await service.acceptInviteRsvp('e', 'u1', 'i1', {
        visibility: 'connections',
      });
      expect(connectionsService.areConnected).toHaveBeenCalledWith('u2', 'u1');
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_INVITE_ACCEPTED,
        inviteAcceptedPayload,
      );
    });

    it('acceptInviteRsvp tells a disconnected inviter nothing under connections visibility', async () => {
      answerReads(openEvent(), invite(EventInviteStatus.Accepted));
      acceptedInviteRows(EventInviteSource.Member);
      connectionsService.areConnected.mockResolvedValue(false);
      await service.acceptInviteRsvp('e', 'u1', 'i1', {
        visibility: 'connections',
      });
      expect(emitter.emit).not.toHaveBeenCalledWith(
        EVENT_INVITE_ACCEPTED,
        expect.anything(),
      );
    });

    it('acceptInviteRsvp tells the inviter nothing under justMe visibility', async () => {
      answerReads(openEvent(), invite(EventInviteStatus.Accepted));
      acceptedInviteRows(EventInviteSource.Member);
      await service.acceptInviteRsvp('e', 'u1', 'i1', { visibility: 'justMe' });
      expect(emitter.emit).not.toHaveBeenCalledWith(
        EVENT_INVITE_ACCEPTED,
        expect.anything(),
      );
    });

    it('acceptInviteRsvp sends no inviter notice for a host invite', async () => {
      answerReads(openEvent(), invite(EventInviteStatus.Accepted));
      acceptedInviteRows(EventInviteSource.Host);
      await service.acceptInviteRsvp('e', 'u1', 'i1', {
        visibility: 'everyone',
      });
      expect(emitter.emit).not.toHaveBeenCalledWith(
        EVENT_INVITE_ACCEPTED,
        expect.anything(),
      );
    });

    it('acceptInviteRsvp announces nothing when the accept rolls back', async () => {
      answerReads(openEvent(), invite(EventInviteStatus.Withdrawn));
      acceptedInviteRows(EventInviteSource.Member);
      await expect(
        service.acceptInviteRsvp('e', 'u1', 'i1', { visibility: 'everyone' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(emitter.emit).not.toHaveBeenCalledWith(
        EVENT_INVITE_ACCEPTED,
        expect.anything(),
      );
    });

    it('a direct first RSVP that answers a member invite tells the inviter (NULL visibility reads as everyone)', async () => {
      answerReads(openEvent(), null);
      acceptedInviteRows(EventInviteSource.Member);
      await service.rsvp('e', 'u1', 'going');
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_INVITE_ACCEPTED,
        inviteAcceptedPayload,
      );
    });

    it('a direct RSVP keeps the row visibility: justMe tells the inviter nothing', async () => {
      answerReads(openEvent(), null);
      rsvpRepo.findOne.mockResolvedValue({
        ...goingRsvp('u1', 0),
        status: RsvpStatus.Cancelled,
        visibility: 'justMe',
      });
      acceptedInviteRows(EventInviteSource.Member);
      await service.rsvp('e', 'u1', 'going');
      expect(emitter.emit).not.toHaveBeenCalledWith(
        EVENT_INVITE_ACCEPTED,
        expect.anything(),
      );
    });

    it('a direct RSVP under connections visibility tells a disconnected inviter nothing', async () => {
      answerReads(openEvent(), null);
      rsvpRepo.findOne.mockResolvedValue({
        ...goingRsvp('u1', 0),
        status: RsvpStatus.Cancelled,
        visibility: 'connections',
      });
      acceptedInviteRows(EventInviteSource.Member);
      connectionsService.areConnected.mockResolvedValue(false);
      await service.rsvp('e', 'u1', 'maybe');
      expect(connectionsService.areConnected).toHaveBeenCalledWith('u2', 'u1');
      expect(emitter.emit).not.toHaveBeenCalledWith(
        EVENT_INVITE_ACCEPTED,
        expect.anything(),
      );
    });

    it('a direct RSVP that answers a host invite tells nobody', async () => {
      answerReads(openEvent(), null);
      acceptedInviteRows(EventInviteSource.Host);
      await service.rsvp('e', 'u1', 'going');
      expect(emitter.emit).not.toHaveBeenCalledWith(
        EVENT_INVITE_ACCEPTED,
        expect.anything(),
      );
    });

    it("cancelRsvp withdraws the canceller's open member invites", async () => {
      answerReads(openEvent(), null);
      rsvpRepo.findOne.mockResolvedValue(goingRsvp('u1', 0));
      await service.cancelRsvp('e', 'u1');
      expectOpenMemberInvitesWithdrawn('u1');
    });

    it("removeAttendee withdraws the removed member's open member invites", async () => {
      answerReads(openEvent(), null);
      profileRepo.findOne.mockResolvedValue({ slug: 'sam', userId: 'u2' });
      rsvpRepo.findOne.mockResolvedValue(goingRsvp('u2', 0));
      await service.removeAttendee('e', 'host-1', 'sam');
      expectOpenMemberInvitesWithdrawn('u2');
    });

    it('updateRsvpDetails refuses a raise past the cap counting open invites', async () => {
      eventRepo.findOne.mockResolvedValue(openEvent());
      answerReads(openEvent(), null);
      rsvpRepo.findOne.mockImplementation(() =>
        Promise.resolve(goingRsvp('u1', 1)),
      );
      managerCount.mockResolvedValue(2);
      const attempt = service.updateRsvpDetails('e', 'u1', { guestCount: 2 });
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(RSVP_GUEST_CAP_MESSAGE);
      expect(managerCount).toHaveBeenCalledWith(EventInvite, {
        where: expect.objectContaining({
          eventId: 'e1',
          inviterId: 'u1',
          source: EventInviteSource.Member,
        }) as Record<string, unknown>,
      });
      expect(rsvpRepo.save).not.toHaveBeenCalled();
    });

    it('updateRsvpDetails keeps a grandfathered count', async () => {
      eventRepo.findOne.mockResolvedValue(openEvent());
      answerReads(openEvent(), null);
      rsvpRepo.findOne.mockImplementation(() =>
        Promise.resolve(goingRsvp('u1', 5)),
      );
      await expect(
        service.updateRsvpDetails('e', 'u1', { guestCount: 5 }),
      ).resolves.toEqual(expect.objectContaining({ guestCount: 5 }));
      await expect(
        service.updateRsvpDetails('e', 'u1', { guestCount: 4 }),
      ).resolves.toEqual(expect.objectContaining({ guestCount: 4 }));
      await expect(
        service.updateRsvpDetails('e', 'u1', { guestCount: 6 }),
      ).rejects.toThrow(RSVP_GUEST_CAP_MESSAGE);
    });
  });
});

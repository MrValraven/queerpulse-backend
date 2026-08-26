import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { CardTokenService } from '../membership-cards/card-token.service';
import { CommunityCard } from '../membership-cards/entities/community-card.entity';
import { MembershipCard } from '../membership-cards/entities/membership-card.entity';
import { Profile } from '../users/entities/profile.entity';
import { EventCheckInService } from './event-check-in.service';
import { EVENT_ATTENDANCE_WINDOW_CLOSED_CODE } from './event-attendance-window';
import { EventsService } from './events.service';
import { EventCohost } from './entities/event-cohost.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';

/**
 * The door's half of the attendance retention promise.
 *
 * The sweep erases `checked_in_at` 30 days after a gathering, and
 * `rosterCounts` stops reporting a count for the same gatherings. Without a
 * guard here the third leg is open: a host opening a door screen on an old
 * gathering would write a FRESH `checked_in_at` onto a row the sweep had
 * already cleared, re-creating the personal data the sweep exists to remove and
 * flipping the count back from "no longer recorded" to 1.
 *
 * Undo is deliberately still allowed past the window, because clearing a stamp
 * removes data rather than creating it.
 */
describe('EventCheckInService attendance window', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOST_ID = 'host-1';
  const MEMBER_ID = 'member-1';

  let events: { findOne: jest.Mock };
  let cohosts: { exists: jest.Mock };
  let rsvps: { findOne: jest.Mock; save: jest.Mock };
  let profiles: { findOne: jest.Mock };
  let cardTokens: { verify: jest.Mock };
  let eventsService: { rosterCounts: jest.Mock };
  let service: EventCheckInService;

  const retention: Record<string, number> = {};

  /** A published gathering that ended `days` ago. */
  const gatheringEndedDaysAgo = (days: number) =>
    ({
      id: 'event-1',
      slug: 'past-supper',
      hostId: HOST_ID,
      startAt: new Date(Date.now() - days * DAY_MS),
      endAt: null,
    }) as unknown as Event;

  const goingRsvp = (checkedInAt: Date | null = null) =>
    ({
      id: 'rsvp-1',
      eventId: 'event-1',
      userId: MEMBER_ID,
      status: RsvpStatus.Going,
      checkedInAt,
    }) as unknown as EventRsvp;

  beforeEach(() => {
    Object.keys(retention).forEach((key) => delete retention[key]);
    retention['retention.eventAttendanceDays'] = 30;

    events = { findOne: jest.fn() };
    cohosts = { exists: jest.fn().mockResolvedValue(false) };
    rsvps = {
      findOne: jest.fn().mockResolvedValue(goingRsvp()),
      save: jest.fn((row: EventRsvp) => Promise.resolve(row)),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue({ userId: MEMBER_ID, slug: 'mara' }),
    };
    cardTokens = { verify: jest.fn() };
    eventsService = {
      rosterCounts: jest.fn().mockResolvedValue({
        goingCount: 40,
        seatsTaken: 44,
        waitlistCount: 3,
        checkedInCount: 18,
      }),
    };

    const config = {
      get: jest.fn(
        (key: string, fallback?: number) => retention[key] ?? fallback,
      ),
    };

    service = new EventCheckInService(
      config as unknown as ConfigService,
      events as unknown as Repository<Event>,
      cohosts as unknown as Repository<EventCohost>,
      rsvps as unknown as Repository<EventRsvp>,
      profiles as unknown as Repository<Profile>,
      {} as unknown as Repository<MembershipCard>,
      {} as unknown as Repository<CommunityCard>,
      {} as unknown as Repository<Community>,
      cardTokens as unknown as CardTokenService,
      eventsService as unknown as EventsService,
    );
  });

  describe('checkIn', () => {
    it('records an arrival inside the window', async () => {
      events.findOne.mockResolvedValue(gatheringEndedDaysAgo(0));
      await service.checkIn('past-supper', HOST_ID, { memberSlug: 'mara' });
      expect(rsvps.save).toHaveBeenCalledTimes(1);
      const saved = rsvps.save.mock.calls[0] as [EventRsvp];
      expect(saved[0].checkedInAt).toBeInstanceOf(Date);
    });

    it('refuses past the window, and writes nothing', async () => {
      events.findOne.mockResolvedValue(gatheringEndedDaysAgo(45));
      await expect(
        service.checkIn('past-supper', HOST_ID, { memberSlug: 'mara' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // The whole point: no fresh `checked_in_at` is created on a row the
      // sweep has already cleared.
      expect(rsvps.save).not.toHaveBeenCalled();
    });

    it('carries the machine-readable code a client branches on', async () => {
      events.findOne.mockResolvedValue(gatheringEndedDaysAgo(45));
      await expect(
        service.checkIn('past-supper', HOST_ID, { memberSlug: 'mara' }),
      ).rejects.toMatchObject({
        response: {
          statusCode: 403,
          code: EVENT_ATTENDANCE_WINDOW_CLOSED_CODE,
        },
      });
    });

    it('refuses a card scan on an old gathering too', async () => {
      // Both write paths into `checked_in_at` go through the same guard.
      events.findOne.mockResolvedValue(gatheringEndedDaysAgo(45));
      await expect(
        service.checkIn('past-supper', HOST_ID, { cardToken: 'card-abc' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(rsvps.save).not.toHaveBeenCalled();
    });

    it('refuses before resolving who is being checked in', async () => {
      // The window is a property of the GATHERING, so there is no reason to
      // look up a member or verify a scanned card for a doomed request.
      events.findOne.mockResolvedValue(gatheringEndedDaysAgo(45));
      await expect(
        service.checkIn('past-supper', HOST_ID, { cardToken: 'card-abc' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(profiles.findOne).not.toHaveBeenCalled();
      expect(cardTokens.verify).not.toHaveBeenCalled();
      expect(rsvps.findOne).not.toHaveBeenCalled();
    });

    it('follows the configured window rather than a hardcoded 30 days', async () => {
      retention['retention.eventAttendanceDays'] = 7;
      events.findOne.mockResolvedValue(gatheringEndedDaysAgo(10));
      await expect(
        service.checkIn('past-supper', HOST_ID, { memberSlug: 'mara' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('the boundary agrees with the count', () => {
    // `isAttendanceCleared` is `<`, so at exactly the cutoff a gathering is NOT
    // yet cleared. The door and the count read that one predicate, so they flip
    // on the same millisecond and can never disagree about whether a gathering
    // still has arrivals.

    it('still accepts at exactly the cutoff instant', async () => {
      events.findOne.mockResolvedValue({
        ...gatheringEndedDaysAgo(0),
        startAt: new Date(Date.now() - 30 * DAY_MS),
      });
      await service.checkIn('past-supper', HOST_ID, { memberSlug: 'mara' });
      expect(rsvps.save).toHaveBeenCalledTimes(1);
    });

    it('refuses one millisecond past it', async () => {
      events.findOne.mockResolvedValue({
        ...gatheringEndedDaysAgo(0),
        startAt: new Date(Date.now() - 30 * DAY_MS - 1),
      });
      await expect(
        service.checkIn('past-supper', HOST_ID, { memberSlug: 'mara' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('measures a long gathering from its end, like the sweep does', async () => {
      // Started 40 days ago, finished yesterday. Past the window on `start_at`,
      // comfortably inside it on `end_at`, so the door must still accept.
      events.findOne.mockResolvedValue({
        ...gatheringEndedDaysAgo(40),
        endAt: new Date(Date.now() - 1 * DAY_MS),
      });
      await service.checkIn('past-supper', HOST_ID, { memberSlug: 'mara' });
      expect(rsvps.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('undoCheckIn', () => {
    it('still clears a stamp past the window', async () => {
      // Undo REMOVES the data the window exists to remove, so refusing it would
      // be the one outcome nobody wants: a stray arrival stamp a host is
      // forbidden from taking off.
      events.findOne.mockResolvedValue(gatheringEndedDaysAgo(45));
      rsvps.findOne.mockResolvedValue(goingRsvp(new Date()));

      await service.undoCheckIn('past-supper', HOST_ID, 'mara');

      expect(rsvps.save).toHaveBeenCalledTimes(1);
      const saved = rsvps.save.mock.calls[0] as [EventRsvp];
      expect(saved[0].checkedInAt).toBeNull();
    });

    it('is a harmless no-op past the window when nothing is stamped', async () => {
      events.findOne.mockResolvedValue(gatheringEndedDaysAgo(45));
      rsvps.findOne.mockResolvedValue(goingRsvp(null));

      await expect(
        service.undoCheckIn('past-supper', HOST_ID, 'mara'),
      ).resolves.toBeDefined();
      expect(rsvps.save).not.toHaveBeenCalled();
    });

    it('still works inside the window', async () => {
      events.findOne.mockResolvedValue(gatheringEndedDaysAgo(1));
      rsvps.findOne.mockResolvedValue(goingRsvp(new Date()));
      await service.undoCheckIn('past-supper', HOST_ID, 'mara');
      expect(rsvps.save).toHaveBeenCalledTimes(1);
    });
  });
});

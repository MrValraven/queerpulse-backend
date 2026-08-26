import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { ListingLookupService } from '../listings/listing-lookup.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { EventAudienceGateService } from './event-audience-gate.service';
import { EventBookmarksService } from './event-bookmarks.service';
import { EventsService } from './events.service';
import { RsvpService } from './rsvp.service';
import { EventAnnouncement } from './entities/event-announcement.entity';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventLineupEntry } from './entities/event-lineup-entry.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { EventSeries } from './entities/event-series.entity';
import { Event } from './entities/event.entity';

/**
 * `EventsService.rosterCounts` and the one thing about it that is easy to get
 * wrong: `checkedInCount` has to stop being a NUMBER once the attendance
 * retention sweep has erased the per-person check-in records, because a
 * `COUNT(*) FILTER (WHERE checked_in_at IS NOT NULL)` over cleared rows
 * returns 0, and 0 reads as "nobody came".
 *
 * The three cases the distinction exists for are the first three tests here:
 * inside the window with arrivals, inside the window with none (a real zero),
 * and past the window (not knowable).
 */
describe('EventsService.rosterCounts', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  let getRawOne: jest.Mock;
  let rsvps: { createQueryBuilder: jest.Mock };
  let service: EventsService;

  const retention: Record<string, number> = {};

  /** A gathering that ended `days` ago, with no stated end time. */
  const endedDaysAgo = (days: number) => ({
    id: 'event-1',
    startAt: new Date(Date.now() - days * DAY_MS),
    endAt: null,
  });

  /** What the aggregate query comes back with. */
  const rawCounts = (counts: {
    going: number;
    seats: number;
    waiting: number;
    checkedIn: number;
  }) => ({
    goingCount: String(counts.going),
    seatsTaken: String(counts.seats),
    waitlistCount: String(counts.waiting),
    checkedInCount: String(counts.checkedIn),
  });

  beforeEach(() => {
    Object.keys(retention).forEach((key) => delete retention[key]);
    retention['retention.eventAttendanceDays'] = 30;

    getRawOne = jest
      .fn()
      .mockResolvedValue(
        rawCounts({ going: 40, seats: 44, waiting: 3, checkedIn: 18 }),
      );
    const builder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      getRawOne,
    };
    rsvps = { createQueryBuilder: jest.fn().mockReturnValue(builder) };

    const config = {
      get: jest.fn(
        (key: string, fallback?: number) => retention[key] ?? fallback,
      ),
    };

    // Only `config` and `rsvps` are reached by `rosterCounts`; the rest are
    // present to satisfy the constructor, exactly as `events.service.spec.ts`
    // does.
    service = new EventsService(
      config as unknown as ConfigService,
      {} as unknown as Repository<Event>,
      {} as unknown as Repository<EventCohost>,
      rsvps as unknown as Repository<EventRsvp>,
      {} as unknown as Repository<EventInvite>,
      {} as unknown as Repository<EventLineupEntry>,
      {} as unknown as Repository<EventSeries>,
      {} as unknown as Repository<EventAnnouncement>,
      {} as unknown as Repository<Profile>,
      {} as unknown as UsersService,
      {} as unknown as RsvpService,
      {} as unknown as NotificationsService,
      {} as unknown as BlockFilterService,
      {} as unknown as ContentModerationService,
      {} as unknown as CommunityMembershipService,
      {} as unknown as EventBookmarksService,
      {} as unknown as EventAudienceGateService,
      {} as unknown as MediaCropService,
      {} as unknown as ListingLookupService,
    );
  });

  describe('checkedInCount', () => {
    it('reports the real number inside the retention window', async () => {
      const counts = await service.rosterCounts(endedDaysAgo(2));
      expect(counts.checkedInCount).toBe(18);
    });

    it('reports a genuine zero inside the window when nobody arrived', async () => {
      // THE case the null exists to stay distinct from. A gathering last week
      // that nobody turned up to really did have zero arrivals, and must keep
      // saying so.
      getRawOne.mockResolvedValue(
        rawCounts({ going: 40, seats: 44, waiting: 3, checkedIn: 0 }),
      );
      const counts = await service.rosterCounts(endedDaysAgo(2));
      expect(counts.checkedInCount).toBe(0);
      expect(counts.checkedInCount).not.toBeNull();
    });

    it('is null past the window, never zero', async () => {
      // The sweep has erased `checked_in_at`, so the query returns 0 for a
      // gathering that was in fact full. Reporting that 0 would tell an
      // organiser nobody came.
      getRawOne.mockResolvedValue(
        rawCounts({ going: 40, seats: 44, waiting: 3, checkedIn: 0 }),
      );
      const counts = await service.rosterCounts(endedDaysAgo(45));
      expect(counts.checkedInCount).toBeNull();
    });

    it('is null past the window even if rows have not been swept yet', async () => {
      // The date decides, not the state of the rows, so the answer cannot
      // flicker with cron timing and can never be a half-swept mixture.
      getRawOne.mockResolvedValue(
        rawCounts({ going: 40, seats: 44, waiting: 3, checkedIn: 12 }),
      );
      const counts = await service.rosterCounts(endedDaysAgo(45));
      expect(counts.checkedInCount).toBeNull();
    });

    it('still reports for a long gathering that only just finished', async () => {
      const longRun = {
        id: 'event-1',
        startAt: new Date(Date.now() - 40 * DAY_MS),
        endAt: new Date(Date.now() - 1 * DAY_MS),
      };
      const counts = await service.rosterCounts(longRun);
      expect(counts.checkedInCount).toBe(18);
    });

    it('follows the configured window rather than a hardcoded 30 days', async () => {
      // The sweeper reads the same key, so shortening it must move both.
      retention['retention.eventAttendanceDays'] = 7;
      const counts = await service.rosterCounts(endedDaysAgo(10));
      expect(counts.checkedInCount).toBeNull();
    });

    it('falls back to 30 days when the setting is absent', async () => {
      delete retention['retention.eventAttendanceDays'];
      expect(
        (await service.rosterCounts(endedDaysAgo(10))).checkedInCount,
      ).toBe(18);
      expect(
        (await service.rosterCounts(endedDaysAgo(45))).checkedInCount,
      ).toBeNull();
    });
  });

  describe('the other three counts', () => {
    it('are unaffected by the retention window', async () => {
      // Only the check-in record is erased. How many said they were going, how
      // many seats that took and how many waited are all still true, and are
      // the numbers a host looks back on.
      const counts = await service.rosterCounts(endedDaysAgo(400));
      expect(counts.goingCount).toBe(40);
      expect(counts.seatsTaken).toBe(44);
      expect(counts.waitlistCount).toBe(3);
    });

    it('default to zero when the aggregate returns no row', async () => {
      getRawOne.mockResolvedValue(undefined);
      const counts = await service.rosterCounts(endedDaysAgo(2));
      expect(counts).toEqual({
        goingCount: 0,
        seatsTaken: 0,
        waitlistCount: 0,
        checkedInCount: 0,
      });
    });
  });

  it('scopes the aggregate to the gathering it was handed', async () => {
    const event = endedDaysAgo(2);
    await service.rosterCounts(event);
    const builder = rsvps.createQueryBuilder.mock.results[0]?.value as {
      where: jest.Mock;
    };
    expect(builder.where).toHaveBeenCalledWith('r.event_id = :eventId', {
      eventId: event.id,
    });
  });
});

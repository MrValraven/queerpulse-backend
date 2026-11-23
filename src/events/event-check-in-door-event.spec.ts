import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IsNull, Not, Repository } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { CardTokenService } from '../membership-cards/card-token.service';
import { CommunityCard } from '../membership-cards/entities/community-card.entity';
import {
  MembershipCard,
  MembershipCardStatus,
} from '../membership-cards/entities/membership-card.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  DECREMENT_EVENTS_ATTENDED_SQL,
  INCREMENT_EVENTS_ATTENDED_SQL,
} from './event-attendance-tally';
import { EventCheckInService } from './event-check-in.service';
import { EVENT_ATTENDEE_CHECKED_IN, EVENT_DOOR_CHANGED } from './event.events';
import { EventsService } from './events.service';
import { EventCohost } from './entities/event-cohost.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';

/**
 * Other door devices learn of a check-in or an undo through one domain event,
 * emitted after the write, only when the state changed, and addressed to the
 * host and the co-hosts.
 */
describe('EventCheckInService door event', () => {
  const HOST_ID = 'host-1';
  const COHOST_ID = 'cohost-1';
  const MEMBER_ID = 'member-1';

  let rsvps: {
    findOne: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let cohosts: { exists: jest.Mock; find: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let service: EventCheckInService;

  /** The emits of one event name. */
  const emitsNamed = (wantedName: string): unknown[][] =>
    (eventEmitter.emit.mock.calls as unknown[][]).filter(
      ([eventName]) => eventName === wantedName,
    );

  /** The emits addressed to the door devices, leaving the badge trigger out. */
  const doorEmits = (): unknown[][] => emitsNamed(EVENT_DOOR_CHANGED);

  /** `sql` with whitespace runs folded and the space inside parentheses dropped. */
  function collapsed(sql: string): string {
    return sql
      .replace(/\s+/g, ' ')
      .replace(/\( /g, '(')
      .replace(/ \)/g, ')')
      .trim();
  }

  const rsvpCheckedInAt = (checkedInAt: Date | null) =>
    ({
      id: 'rsvp-1',
      eventId: 'event-1',
      userId: MEMBER_ID,
      status: RsvpStatus.Going,
      checkedInAt,
    }) as unknown as EventRsvp;

  beforeEach(() => {
    rsvps = {
      findOne: jest.fn().mockResolvedValue(rsvpCheckedInAt(null)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn().mockResolvedValue([]),
      // The transaction hands back this same stub as its repository, so the
      // conditional update and the tally statement land on `update` and `query`.
      manager: {
        transaction: jest.fn(
          (work: (manager: { getRepository: () => unknown }) => unknown) =>
            work({ getRepository: () => rsvps }),
        ),
      },
    };
    cohosts = {
      exists: jest.fn().mockResolvedValue(false),
      find: jest.fn().mockResolvedValue([{ userId: COHOST_ID }]),
    };
    eventEmitter = { emit: jest.fn() };
    const events = {
      findOne: jest.fn().mockResolvedValue({
        id: 'event-1',
        slug: 'supper',
        hostId: HOST_ID,
        startAt: new Date(),
        endAt: null,
      }),
    };
    const profiles = {
      findOne: jest.fn().mockResolvedValue({
        userId: MEMBER_ID,
        slug: 'mara',
        user: { status: 'active' },
      }),
    };
    // A good card held by the same member, read the way the card spec reads
    // one, so the scan path reaches the same announcement.
    const cards = {
      findOne: jest.fn().mockResolvedValue({
        id: 'card-1',
        programId: 'prog-1',
        userId: MEMBER_ID,
        status: MembershipCardStatus.Active,
        expiresAt: null,
        codeVersion: 1,
      }),
    };
    const cardPrograms = {
      findOne: jest.fn().mockResolvedValue({
        id: 'prog-1',
        issuerId: 'com-1',
        isEnabled: true,
      }),
    };
    const communities = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'com-1', frozenAt: null, archivedAt: null }),
    };
    const cardTokens = {
      verify: jest.fn().mockReturnValue({ cardId: 'card-1', codeVersion: 1 }),
    };
    const eventsService = {
      rosterCounts: jest.fn().mockResolvedValue({
        goingCount: 1,
        seatsTaken: 1,
        waitlistCount: 0,
        checkedInCount: 1,
      }),
    };
    service = new EventCheckInService(
      {
        get: jest.fn((_key: string, fallback?: number) => fallback),
      } as unknown as ConfigService,
      events as unknown as Repository<Event>,
      cohosts as unknown as Repository<EventCohost>,
      rsvps as unknown as Repository<EventRsvp>,
      profiles as unknown as Repository<Profile>,
      cards as unknown as Repository<MembershipCard>,
      cardPrograms as unknown as Repository<CommunityCard>,
      communities as unknown as Repository<Community>,
      cardTokens as unknown as CardTokenService,
      eventsService as unknown as EventsService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  it('emits once for a check-in that changed state, naming the organisers', async () => {
    await service.checkIn('supper', HOST_ID, { memberSlug: 'mara' });
    expect(doorEmits()).toHaveLength(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith(EVENT_DOOR_CHANGED, {
      eventSlug: 'supper',
      memberSlug: 'mara',
      change: 'checked_in',
      organizerUserIds: [HOST_ID, COHOST_ID],
    });
  });

  it('emits once for a scanned card check-in that changed state, naming the guest', async () => {
    await service.checkIn('supper', HOST_ID, { cardToken: 'signed.code' });
    expect(doorEmits()).toHaveLength(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith(EVENT_DOOR_CHANGED, {
      eventSlug: 'supper',
      memberSlug: 'mara',
      change: 'checked_in',
      organizerUserIds: [HOST_ID, COHOST_ID],
    });
  });

  it('emits nothing for a repeat check-in of an arrived guest', async () => {
    rsvps.findOne.mockResolvedValue(rsvpCheckedInAt(new Date()));
    await service.checkIn('supper', HOST_ID, { memberSlug: 'mara' });
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('emits an undone change when an arrival is taken back', async () => {
    rsvps.findOne.mockResolvedValue(rsvpCheckedInAt(new Date()));
    await service.undoCheckIn('supper', HOST_ID, 'mara');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_DOOR_CHANGED,
      expect.objectContaining({ change: 'undone', memberSlug: 'mara' }),
    );
  });

  it('emits nothing when an undo finds nobody arrived', async () => {
    await service.undoCheckIn('supper', HOST_ID, 'mara');
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('still returns the result when announcing fails', async () => {
    cohosts.find.mockRejectedValue(new Error('db down'));
    await expect(
      service.checkIn('supper', HOST_ID, { memberSlug: 'mara' }),
    ).resolves.toMatchObject({ goingCount: 1 });
  });

  it('names the arrived member to the badge trigger once per changed check-in', async () => {
    await service.checkIn('supper', HOST_ID, { memberSlug: 'mara' });
    expect(emitsNamed(EVENT_ATTENDEE_CHECKED_IN)).toHaveLength(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith(EVENT_ATTENDEE_CHECKED_IN, {
      eventId: 'event-1',
      communityId: null,
      userId: MEMBER_ID,
    });
  });

  it('names nobody for a repeat check-in or an undo', async () => {
    rsvps.findOne.mockResolvedValue(rsvpCheckedInAt(new Date()));
    await service.checkIn('supper', HOST_ID, { memberSlug: 'mara' });
    await service.undoCheckIn('supper', HOST_ID, 'mara');
    expect(eventEmitter.emit).not.toHaveBeenCalledWith(
      EVENT_ATTENDEE_CHECKED_IN,
      expect.anything(),
    );
  });

  it('adds one to the tally for a check-in that changed state, before the badge trigger hears of it', async () => {
    await service.checkIn('supper', HOST_ID, { memberSlug: 'mara' });
    expect(rsvps.query).toHaveBeenCalledTimes(1);
    expect(rsvps.query).toHaveBeenCalledWith(INCREMENT_EVENTS_ATTENDED_SQL, [
      'event-1',
      MEMBER_ID,
    ]);
    expect(rsvps.query.mock.invocationCallOrder[0]).toBeLessThan(
      eventEmitter.emit.mock.invocationCallOrder[
        eventEmitter.emit.mock.calls.findIndex(
          ([eventName]) => eventName === EVENT_ATTENDEE_CHECKED_IN,
        )
      ] ?? -1,
    );
  });

  it('takes one off the tally for an undo that changed state', async () => {
    rsvps.findOne.mockResolvedValue(rsvpCheckedInAt(new Date()));
    await service.undoCheckIn('supper', HOST_ID, 'mara');
    expect(rsvps.query).toHaveBeenCalledWith(DECREMENT_EVENTS_ATTENDED_SQL, [
      'event-1',
      MEMBER_ID,
    ]);
  });

  it('leaves the tally alone for a repeat check-in and for an undo with nobody arrived', async () => {
    rsvps.findOne.mockResolvedValueOnce(rsvpCheckedInAt(new Date()));
    await service.checkIn('supper', HOST_ID, { memberSlug: 'mara' });
    await service.undoCheckIn('supper', HOST_ID, 'mara');
    expect(rsvps.query).not.toHaveBeenCalled();
  });

  it('stamps the arrival only while the row has none, inside the tally transaction', async () => {
    await service.checkIn('supper', HOST_ID, { memberSlug: 'mara' });
    expect(rsvps.manager.transaction).toHaveBeenCalledTimes(1);
    expect(rsvps.update).toHaveBeenCalledWith(
      { id: 'rsvp-1', checkedInAt: IsNull() },
      { checkedInAt: expect.any(Date) as unknown },
    );
  });

  it('clears the stamp only while the row has one, inside the tally transaction', async () => {
    rsvps.findOne.mockResolvedValue(rsvpCheckedInAt(new Date()));
    await service.undoCheckIn('supper', HOST_ID, 'mara');
    expect(rsvps.manager.transaction).toHaveBeenCalledTimes(1);
    expect(rsvps.update).toHaveBeenCalledWith(
      { id: 'rsvp-1', checkedInAt: Not(IsNull()) },
      { checkedInAt: null },
    );
  });

  it('counts nothing and names nobody when a simultaneous check-in stamped the row first', async () => {
    rsvps.update.mockResolvedValue({ affected: 0 });
    await service.checkIn('supper', HOST_ID, { memberSlug: 'mara' });
    expect(rsvps.query).not.toHaveBeenCalled();
    expect(emitsNamed(EVENT_ATTENDEE_CHECKED_IN)).toHaveLength(0);
    expect(doorEmits()).toHaveLength(0);
  });

  it('takes nothing off the tally when a simultaneous undo cleared the row first', async () => {
    rsvps.findOne.mockResolvedValue(rsvpCheckedInAt(new Date()));
    rsvps.update.mockResolvedValue({ affected: 0 });
    await service.undoCheckIn('supper', HOST_ID, 'mara');
    expect(rsvps.query).not.toHaveBeenCalled();
    expect(doorEmits()).toHaveLength(0);
  });

  it('floors the tally at zero and matches only a roster row of the event community', () => {
    expect(collapsed(DECREMENT_EVENTS_ATTENDED_SQL)).toContain(
      'GREATEST("m"."events_attended_count" - 1, 0)',
    );
    expect(collapsed(INCREMENT_EVENTS_ATTENDED_SQL)).toContain(
      '"m"."community_id" = "e"."community_id" AND "m"."user_id" = $2',
    );
  });
});

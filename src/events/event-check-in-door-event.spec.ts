import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { CardTokenService } from '../membership-cards/card-token.service';
import { CommunityCard } from '../membership-cards/entities/community-card.entity';
import {
  MembershipCard,
  MembershipCardStatus,
} from '../membership-cards/entities/membership-card.entity';
import { Profile } from '../users/entities/profile.entity';
import { EventCheckInService } from './event-check-in.service';
import { EVENT_DOOR_CHANGED } from './event.events';
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

  let rsvps: { findOne: jest.Mock; save: jest.Mock };
  let cohosts: { exists: jest.Mock; find: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let service: EventCheckInService;

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
      save: jest.fn((row: EventRsvp) => Promise.resolve(row)),
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
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith(EVENT_DOOR_CHANGED, {
      eventSlug: 'supper',
      memberSlug: 'mara',
      change: 'checked_in',
      organizerUserIds: [HOST_ID, COHOST_ID],
    });
  });

  it('emits once for a scanned card check-in that changed state, naming the guest', async () => {
    await service.checkIn('supper', HOST_ID, { cardToken: 'signed.code' });
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
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
});

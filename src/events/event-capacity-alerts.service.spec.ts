import { NotificationType } from '../notifications/entities/notification.entity';
import { RsvpStatus } from './entities/event-rsvp.entity';
import { EventStatus } from './entities/event.entity';
import {
  EventCapacityAlertsService,
  NEARLY_FULL_MIN_CAPACITY,
} from './event-capacity-alerts.service';

const HOUR_MS = 60 * 60 * 1000;

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    slug: 'queer-book-club',
    title: 'Queer Book Club',
    status: EventStatus.Published,
    startAt: new Date(Date.now() + 48 * HOUR_MS),
    capacity: 20,
    nearlyFullNotifiedAt: null,
    ...overrides,
  };
}

// Chainable stub for the seats-taken aggregate.
function seatsQbStub(seats: number) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['select', 'where', 'andWhere']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawOne = jest.fn().mockResolvedValue({ seats: String(seats) });
  return qb;
}

function build({
  event = baseEvent(),
  seats = 18,
  bookmarkUserIds = ['saver-1'],
  maybeUserIds = ['maybe-1'],
  settledUserIds = [] as string[],
}: {
  event?: Record<string, unknown> | null;
  seats?: number;
  bookmarkUserIds?: string[];
  maybeUserIds?: string[];
  settledUserIds?: string[];
} = {}) {
  const events = {
    findOne: jest.fn().mockResolvedValue(event),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const rsvps = {
    createQueryBuilder: jest.fn().mockReturnValue(seatsQbStub(seats)),
    find: jest.fn((options: { where: { status?: unknown } }) => {
      const wanted = options.where.status;
      if (wanted === RsvpStatus.Maybe) {
        return Promise.resolve(maybeUserIds.map((userId) => ({ userId })));
      }
      return Promise.resolve(settledUserIds.map((userId) => ({ userId })));
    }),
  };
  const bookmarks = {
    find: jest
      .fn()
      .mockResolvedValue(bookmarkUserIds.map((userId) => ({ userId }))),
  };
  const notifications = {
    createForRecipients: jest.fn().mockResolvedValue([]),
  };
  const service = new EventCapacityAlertsService(
    events as never,
    rsvps as never,
    bookmarks as never,
    notifications as never,
  );
  return { service, events, rsvps, bookmarks, notifications };
}

describe('EventCapacityAlertsService', () => {
  it('alerts savers and maybes when the last few seats go', async () => {
    const { service, notifications } = build({ seats: 18 });
    await service.onSeatsChanged('event-1');
    expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
    const [recipients, type, payload] = notifications.createForRecipients.mock
      .calls[0] as [string[], NotificationType, Record<string, unknown>];
    expect(recipients.sort()).toEqual(['maybe-1', 'saver-1']);
    expect(type).toBe(NotificationType.EventNearlyFull);
    expect(payload).toEqual({
      source: 'event',
      eventSlug: 'queer-book-club',
      title: 'Queer Book Club',
      seatsRemaining: 2,
    });
  });

  it('never tells somebody who already holds a seat or a waitlist place', async () => {
    const { service, notifications } = build({
      seats: 18,
      bookmarkUserIds: ['going-1', 'saver-1'],
      maybeUserIds: [],
      settledUserIds: ['going-1'],
    });
    await service.onSeatsChanged('event-1');
    const [recipients] = notifications.createForRecipients.mock.calls[0] as [
      string[],
    ];
    expect(recipients).toEqual(['saver-1']);
  });

  it('claims the event before sending, so a second RSVP sends nothing', async () => {
    const { service, events, notifications } = build({ seats: 18 });
    events.update.mockResolvedValueOnce({ affected: 0 });
    await service.onSeatsChanged('event-1');
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('stays quiet while there is still room', async () => {
    const { service, notifications } = build({ seats: 10 });
    await service.onSeatsChanged('event-1');
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('releases a spent claim once seats free up again', async () => {
    const { service, events, notifications } = build({
      event: baseEvent({ nearlyFullNotifiedAt: new Date() }),
      seats: 10,
    });
    await service.onSeatsChanged('event-1');
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(events.update).toHaveBeenCalledWith(
      { id: 'event-1' },
      { nearlyFullNotifiedAt: null },
    );
  });

  it('stays quiet on a full event, which is a waitlist rather than last spots', async () => {
    const { service, notifications } = build({ seats: 20 });
    await service.onSeatsChanged('event-1');
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('stays quiet on a room too small for "nearly full" to mean anything', async () => {
    const { service, notifications } = build({
      event: baseEvent({ capacity: NEARLY_FULL_MIN_CAPACITY - 1 }),
      seats: 3,
    });
    await service.onSeatsChanged('event-1');
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('stays quiet on an uncapped, unpublished, or already-started gathering', async () => {
    for (const event of [
      baseEvent({ capacity: null }),
      baseEvent({ status: EventStatus.Draft }),
      baseEvent({ startAt: new Date(Date.now() - HOUR_MS) }),
    ]) {
      const { service, notifications } = build({ event, seats: 18 });
      await service.onSeatsChanged('event-1');
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    }
  });

  it('hands the claim back when the send fails, so the next RSVP retries', async () => {
    const { service, events, notifications } = build({ seats: 18 });
    notifications.createForRecipients.mockRejectedValueOnce(
      new Error('database is having a moment'),
    );
    // Swallowed by design: an alert must never fail the RSVP behind it.
    await expect(service.onSeatsChanged('event-1')).resolves.toBeUndefined();
    expect(events.update).toHaveBeenLastCalledWith(
      { id: 'event-1' },
      { nearlyFullNotifiedAt: null },
    );
  });
});

import { FindOperator, FindOptionsWhere, In } from 'typeorm';
import { Event, EventStatus } from '../events/entities/event.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { ContentOwnerErasureService } from './content-owner-erasure.service';

const HOUR_IN_MILLISECONDS = 3_600_000;
const DAY_IN_MILLISECONDS = 86_400_000;

// The erased member.
const ERASED_USER_ID = 'erased-host';

/**
 * Multi-day and overnight gatherings on the erasure path.
 *
 * `handleFutureGatherings` used to select on `startAt: MoreThan(now)`, so a
 * three-day festival whose host erased their account on day two fell out of the
 * method entirely: no co-host inherited it, and the live gathering was left with
 * nobody who could edit it, message its attendees or check anyone in.
 *
 * The fix widens the SELECTION to "not yet over" while keeping CANCELLATION
 * restricted to gatherings that have not started, so nobody standing in a room
 * is told the thing they are at is off.
 */
describe('ContentOwnerErasureService gatherings', () => {
  const gathering = (overrides: Partial<Event> = {}): Event =>
    ({
      id: 'event-1',
      slug: 'three-day-festival',
      title: 'Three Day Festival',
      hostId: ERASED_USER_ID,
      status: EventStatus.Published,
      startAt: new Date(Date.now() + 48 * HOUR_IN_MILLISECONDS),
      endAt: null,
      seriesId: null,
      ...overrides,
    }) as Event;

  // Day two of a three-day festival: it began yesterday and runs to tomorrow.
  const runningFestival = (overrides: Partial<Event> = {}): Event =>
    gathering({
      startAt: new Date(Date.now() - DAY_IN_MILLISECONDS),
      endAt: new Date(Date.now() + DAY_IN_MILLISECONDS),
      ...overrides,
    });

  const build = ({
    unfinishedEvents = [] as Event[],
    cohostRows = [] as { eventId: string; userId: string }[],
    hostedSeries = [] as { id: string }[],
    seriesOccurrences = [] as Event[],
  } = {}) => {
    const events = {
      // Call one selects the erased host's unfinished gatherings. Call two,
      // reached only when the member hosts a series, selects that series'
      // unfinished occurrences.
      find: jest
        .fn()
        .mockResolvedValueOnce(unfinishedEvents)
        .mockResolvedValue(seriesOccurrences),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const cohosts = {
      find: jest.fn().mockResolvedValue(cohostRows),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const rsvps = { find: jest.fn().mockResolvedValue([{ userId: 'goer-1' }]) };
    const invites = { find: jest.fn().mockResolvedValue([]) };
    const eventSeries = {
      find: jest.fn().mockResolvedValue(hostedSeries),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const noOpUpdate = { update: jest.fn().mockResolvedValue({ affected: 0 }) };
    const notifications = {
      createForRecipients: jest.fn().mockResolvedValue([]),
    };
    const service = new ContentOwnerErasureService(
      events as never,
      cohosts as never,
      rsvps as never,
      invites as never,
      eventSeries as never,
      noOpUpdate as never,
      noOpUpdate as never,
      noOpUpdate as never,
      notifications as never,
    );
    return { service, events, cohosts, eventSeries, notifications };
  };

  // The Date a `MoreThan(...)` arm was built around, so a test can compare the
  // instant two separate queries reasoned about.
  const boundInstant = (
    arm: FindOptionsWhere<Event>,
    field: 'startAt' | 'endAt',
  ): Date => (arm[field] as FindOperator<Date>).value;

  const whereArmsOf = (call: unknown): FindOptionsWhere<Event>[] =>
    (call as [{ where: FindOptionsWhere<Event>[] }])[0].where;

  it('selects on the interval rather than on the start alone', async () => {
    const { service, events } = build();
    await service.eraseFor(ERASED_USER_ID);
    const where = whereArmsOf(events.find.mock.calls[0]);
    // Two arms: one testing the start, one testing the end. Find-options
    // cannot write the disjunct inline, so an OR of two fully-scoped arms is
    // the shape, exactly as `community-public.service.ts` does it.
    expect(Array.isArray(where)).toBe(true);
    expect(where).toHaveLength(2);
    expect(where[0]).toHaveProperty('startAt');
    expect(where[1]).toHaveProperty('endAt');
    // Both arms carry the whole scope, so neither can admit a gathering the
    // other would refuse.
    for (const arm of where) {
      expect(arm).toMatchObject({ hostId: ERASED_USER_ID });
      expect(arm).toHaveProperty('status');
    }
  });

  it('hands a festival that is running right now to its co-host', async () => {
    const { service, events, cohosts } = build({
      unfinishedEvents: [runningFestival()],
      cohostRows: [{ eventId: 'event-1', userId: 'cohost-1' }],
    });
    await service.eraseFor(ERASED_USER_ID);
    expect(events.update).toHaveBeenCalledWith(
      { id: 'event-1' },
      { hostId: 'cohost-1' },
    );
    // The successor's co-host row goes, so they are not both host and co-host.
    expect(cohosts.delete).toHaveBeenCalledWith({
      eventId: 'event-1',
      userId: 'cohost-1',
    });
  });

  // The whole point of keeping the two outcomes scoped differently. Telling a
  // room full of people who already turned up that the thing they are at is
  // cancelled would be worse than the silence it replaces.
  it('never cancels a gathering that is already under way', async () => {
    const { service, events, notifications } = build({
      unfinishedEvents: [runningFestival()],
    });
    await service.eraseFor(ERASED_USER_ID);
    expect(events.update).not.toHaveBeenCalled();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('still cancels a gathering that has not started and has no co-host', async () => {
    const { service, events, notifications } = build({
      unfinishedEvents: [gathering()],
    });
    await service.eraseFor(ERASED_USER_ID);
    // `cancelEvents` flips the whole set in ONE statement, so the id filter is
    // an `In` over the cancelled ids.
    expect(events.update).toHaveBeenCalledWith(
      { id: In(['event-1']) },
      { status: EventStatus.Cancelled },
    );
    const [recipients, type] = notifications.createForRecipients.mock
      .calls[0] as [string[], NotificationType];
    expect(recipients).toEqual(['goer-1']);
    expect(type).toBe(NotificationType.EventCancelled);
  });

  // One erasure, one mixed calendar: the running festival is handed over, the
  // gathering next week is called off.
  it('handles a running gathering and a future one in the same pass', async () => {
    const { service, events, notifications } = build({
      unfinishedEvents: [
        runningFestival(),
        gathering({ id: 'event-2', slug: 'next-week' }),
      ],
      cohostRows: [{ eventId: 'event-1', userId: 'cohost-1' }],
    });
    await service.eraseFor(ERASED_USER_ID);
    expect(events.update).toHaveBeenCalledWith(
      { id: 'event-1' },
      { hostId: 'cohost-1' },
    );
    // Only the one that has not started is in the cancelled set.
    expect(events.update).toHaveBeenCalledWith(
      { id: In(['event-2']) },
      { status: EventStatus.Cancelled },
    );
    expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
  });

  /**
   * A repeat rule follows its occurrences. `releaseHostedSeries` reads the
   * successor map `handleFutureGatherings` built, so its own occurrence
   * selection has to move in lockstep with that method's, and both have to
   * reason about ONE instant.
   */
  describe('the series a handed-over occurrence belongs to', () => {
    const seriesOccurrence = (overrides: Partial<Event> = {}): Event =>
      runningFestival({ seriesId: 'series-1', ...overrides });

    const buildWithSeries = () =>
      build({
        unfinishedEvents: [seriesOccurrence()],
        cohostRows: [{ eventId: 'event-1', userId: 'cohost-1' }],
        hostedSeries: [{ id: 'series-1' }],
        seriesOccurrences: [seriesOccurrence()],
      });

    // The case the lockstep exists for: the ONLY handed-over occurrence is the
    // one currently running. A future-only occurrence lookup would find
    // nothing, and the co-host who was just handed the gathering could not
    // reschedule the series it belongs to.
    it('follows an occurrence that is running right now to its co-host', async () => {
      const { service, eventSeries } = buildWithSeries();
      await service.eraseFor(ERASED_USER_ID);
      expect(eventSeries.update).toHaveBeenCalledWith(
        { id: 'series-1' },
        { hostId: 'cohost-1' },
      );
    });

    it('selects occurrences on the same interval shape as the first pass', async () => {
      const { service, events } = buildWithSeries();
      await service.eraseFor(ERASED_USER_ID);
      const occurrenceArms = whereArmsOf(events.find.mock.calls[1]);
      expect(occurrenceArms).toHaveLength(2);
      expect(occurrenceArms[0]).toHaveProperty('startAt');
      expect(occurrenceArms[1]).toHaveProperty('endAt');
      // Both arms carry the series scope, so neither admits an occurrence the
      // other would refuse.
      for (const arm of occurrenceArms) {
        expect(arm).toHaveProperty('seriesId');
      }
    });

    // Identity, deliberately. Two `new Date()` reads inside one logical
    // operation would produce equal-looking instants most of the time and
    // differing ones under load, so comparing VALUES would pass while the race
    // was still there. The same object proves one clock.
    it('reasons about the caller instant rather than reading the clock again', async () => {
      const { service, events } = buildWithSeries();
      await service.eraseFor(ERASED_USER_ID);
      const firstPassArms = whereArmsOf(events.find.mock.calls[0]);
      const occurrenceArms = whereArmsOf(events.find.mock.calls[1]);
      expect(boundInstant(occurrenceArms[0]!, 'startAt')).toBe(
        boundInstant(firstPassArms[0]!, 'startAt'),
      );
      expect(boundInstant(occurrenceArms[1]!, 'endAt')).toBe(
        boundInstant(firstPassArms[1]!, 'endAt'),
      );
    });

    // The map is keyed by event id, so an occurrence nobody inherited leaves
    // the series hostless and the FK blanks it.
    it('leaves the series alone when no occurrence found a successor', async () => {
      const { service, eventSeries } = build({
        unfinishedEvents: [seriesOccurrence()],
        hostedSeries: [{ id: 'series-1' }],
        seriesOccurrences: [seriesOccurrence()],
      });
      await service.eraseFor(ERASED_USER_ID);
      expect(eventSeries.update).not.toHaveBeenCalled();
    });
  });
});

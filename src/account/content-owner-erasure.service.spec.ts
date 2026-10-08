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
      // A handover seats the new host as 'going' (`seatHostAsGoing`).
      manager: { query: jest.fn().mockResolvedValue([]) },
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
      // The forum and topic steps (ENG-494); nothing to find here.
      { query: jest.fn().mockResolvedValue([[], 0]) } as never,
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

  /** The run-by clearing calls the events manager received, as `[sql, parameters]`. */
  const runByClearingCalls = (events: { manager: { query: jest.Mock } }) =>
    (events.manager.query.mock.calls as [string, unknown[]][]).filter(([sql]) =>
      sql.includes('"run_by_listing_id" = NULL'),
    );

  it('clears the run-by line of a handed-over gathering unless the new host runs that business', async () => {
    const { service, events } = build({
      unfinishedEvents: [runningFestival()],
      cohostRows: [{ eventId: 'event-1', userId: 'cohost-1' }],
    });

    await service.eraseFor(ERASED_USER_ID);

    const calls = runByClearingCalls(events);
    expect(calls).toHaveLength(1);
    const [, parameters] = calls[0]!;
    expect(parameters[0]).toBeInstanceOf(Date);
    expect(parameters[1]).toEqual(['event-1']);
  });

  it('runs no run-by pass when nothing was handed over', async () => {
    const { service, events } = build({ unfinishedEvents: [gathering()] });

    await service.eraseFor(ERASED_USER_ID);

    expect(runByClearingCalls(events)).toHaveLength(0);
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

/**
 * ENG-494: `forum_thread.author_id` is `SET NULL`, so a thread outlives its
 * author's erasure. It should only when other members' replies live in it.
 * These steps are set-based SQL, so the cases below pin the statement each
 * category depends on.
 */
describe('ContentOwnerErasureService forum threads', () => {
  const build = () => {
    const emptyFind = { find: jest.fn().mockResolvedValue([]) };
    const noOpUpdate = { update: jest.fn().mockResolvedValue({ affected: 0 }) };
    const dataSource = {
      query: jest.fn().mockResolvedValue([[{ id: 'thread-1' }], 1]),
    };
    const service = new ContentOwnerErasureService(
      emptyFind as never,
      emptyFind as never,
      emptyFind as never,
      emptyFind as never,
      emptyFind as never,
      noOpUpdate as never,
      noOpUpdate as never,
      noOpUpdate as never,
      { createForRecipients: jest.fn() } as never,
      dataSource as never,
    );
    return { service, dataSource };
  };

  const statements = (dataSource: { query: jest.Mock }) =>
    (dataSource.query.mock.calls as Array<[string, unknown[]]>).map(
      ([sql, parameters]) => ({
        sql: sql.replace(/\s+/g, ' '),
        parameters,
      }),
    );

  const threadDeletion = async () => {
    const { service, dataSource } = build();
    await service.eraseFor(ERASED_USER_ID);
    const deletion = statements(dataSource).find(({ sql }) =>
      sql.startsWith('DELETE FROM "forum_thread"'),
    );
    if (!deletion) throw new Error('expected the forum thread deletion');
    return deletion;
  };

  it('scopes the thread deletion to the erased member', async () => {
    const deletion = await threadDeletion();
    expect(deletion.sql).toContain('"t"."author_id" = $1');
    expect(deletion.parameters).toEqual([ERASED_USER_ID]);
  });

  it('deletes a scheduled thread', async () => {
    const deletion = await threadDeletion();
    expect(deletion.sql).toContain('NOT ("t".published_at <= now()');
  });

  it('deletes a thread pending review or rejected', async () => {
    const deletion = await threadDeletion();
    expect(deletion.sql).toContain(
      `("t".review_state IS NULL OR "t".review_state = 'approved')`,
    );
  });

  it('deletes a withdrawn thread', async () => {
    const deletion = await threadDeletion();
    expect(deletion.sql).toContain('OR "t"."deleted_at" IS NOT NULL');
  });

  it('deletes a thread with no live reply from another member', async () => {
    const deletion = await threadDeletion();
    expect(deletion.sql).toContain('AND NOT EXISTS');
    expect(deletion.sql).toContain('"p"."author_id" <> $1');
    expect(deletion.sql).toContain('"p"."deleted_at" IS NULL');
  });

  // The ruling on shared work: a thread that credits a co-author who still
  // has an account survives with its author NULLed, replies or not.
  it('keeps a co-authored live thread with no replies, with its author NULLed', async () => {
    const deletion = await threadDeletion();
    // The no-reply arm only fires for a thread with no co-author, so a live,
    // published, co-authored thread matches no arm and is left standing for
    // the `SET NULL` FK to orphan.
    expect(deletion.sql).toContain(
      'OR ( "t"."co_author_id" IS NULL AND NOT EXISTS (',
    );
  });

  it('still deletes a co-authored thread that is scheduled', async () => {
    const deletion = await threadDeletion();
    // The visibility and withdrawn arms stand on their own, ahead of the
    // co-author group, so a co-author does not save a thread that never went
    // live or was withdrawn.
    const coAuthorGroupAt = deletion.sql.indexOf('"t"."co_author_id"');
    const scheduledArmAt = deletion.sql.indexOf(
      'NOT ("t".published_at <= now()',
    );
    const withdrawnArmAt = deletion.sql.indexOf(
      'OR "t"."deleted_at" IS NOT NULL',
    );
    expect(scheduledArmAt).toBeGreaterThan(-1);
    expect(withdrawnArmAt).toBeGreaterThan(scheduledArmAt);
    expect(coAuthorGroupAt).toBeGreaterThan(withdrawnArmAt);
    expect(deletion.sql.match(/"t"\."co_author_id"/g)).toHaveLength(1);
  });

  it('keeps a live thread other members replied in', async () => {
    // Every arm is an OR under the author scope, so a thread that is
    // published, through review, not withdrawn and has another member's live
    // reply matches none of them and survives with its author NULLed.
    const deletion = await threadDeletion();
    const arms = deletion.sql.split(' OR ');
    expect(arms[0]).toContain('"t"."author_id" = $1 AND ( NOT (');
    // Survival reads the replies themselves. The denormalized counter can be
    // stale, so it must not decide what gets deleted.
    expect(deletion.sql).not.toContain('"t"."reply_count"');
  });

  it('recounts replies on threads the member replied in, without their replies', async () => {
    const { service, dataSource } = build();
    await service.eraseFor(ERASED_USER_ID);
    const recount = statements(dataSource).find(({ sql }) =>
      sql.includes('SET "reply_count"'),
    );
    if (!recount) throw new Error('expected the reply count recount');
    expect(recount.sql).toContain('"p"."author_id" <> $1');
    expect(recount.sql).toContain('"p"."is_op" = false');
    expect(recount.sql).toContain('"own"."author_id" = $1');
    expect(recount.parameters).toEqual([ERASED_USER_ID]);
  });

  it("scrubs the member's name from the topic posts that copied it", async () => {
    const { service, dataSource } = build();
    await service.eraseFor(ERASED_USER_ID);
    const scrub = statements(dataSource).find(({ sql }) =>
      sql.startsWith('UPDATE "topic_post"'),
    );
    if (!scrub) throw new Error('expected the topic post byline scrub');
    expect(scrub.sql).toContain('WHERE "author_id" = $1');
    expect(scrub.parameters).toEqual([
      ERASED_USER_ID,
      'Member',
      'M',
      'default',
    ]);
  });

  it('runs the deletion before the recount and the scrub', async () => {
    const { service, dataSource } = build();
    await service.eraseFor(ERASED_USER_ID);
    const order = statements(dataSource).map(({ sql }) => sql.slice(0, 34));
    expect(order).toEqual([
      'DELETE FROM "forum_thread" AS "t" ',
      'DELETE FROM "forum_thread_funding"',
      'UPDATE "forum_thread" "t" SET "rep',
      'UPDATE "topic_post" SET "author_na',
    ]);
  });

  // Funding & Grants: a surviving fundraiser keeps nobody accountable for
  // its donate link once its author is erased; a surviving call keeps its
  // public funder link.
  it("removes the funding details of the member's surviving fundraisers only", async () => {
    const { service, dataSource } = build();
    await service.eraseFor(ERASED_USER_ID);
    const fundingDeletion = statements(dataSource).find(({ sql }) =>
      sql.startsWith('DELETE FROM "forum_thread_funding"'),
    );
    if (!fundingDeletion) {
      throw new Error('expected the fundraiser funding deletion');
    }
    expect(fundingDeletion.sql).toContain('USING "forum_thread" AS "t"');
    expect(fundingDeletion.sql).toContain('"funding"."thread_id" = "t"."id"');
    expect(fundingDeletion.sql).toContain('"t"."author_id" = $1');
    expect(fundingDeletion.sql).toContain(`"t"."kind" = 'ask'`);
    expect(fundingDeletion.sql).not.toContain("'call'");
    expect(fundingDeletion.parameters).toEqual([ERASED_USER_ID]);
  });

  it('still scrubs the topic bylines when the thread deletion fails', async () => {
    const { service, dataSource } = build();
    dataSource.query.mockRejectedValueOnce(new Error('deadlock'));
    await service.eraseFor(ERASED_USER_ID);
    expect(
      statements(dataSource).some(({ sql }) =>
        sql.startsWith('UPDATE "topic_post"'),
      ),
    ).toBe(true);
  });
});

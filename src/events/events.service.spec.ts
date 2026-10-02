import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { AccessTier } from '../communities/entities/community.entity';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ListingLookupService } from '../listings/listing-lookup.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { EventAudienceGateService } from './event-audience-gate.service';
import { EventBookmarksService } from './event-bookmarks.service';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventLineupEntry } from './entities/event-lineup-entry.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { EventAnnouncement } from './entities/event-announcement.entity';
import { EventSeries } from './entities/event-series.entity';
import { EVENT_DELETING } from './event.events';
import {
  Event,
  EventStatus,
  EventVisibility,
  GatheringFamily,
} from './entities/event.entity';
import { EventsService } from './events.service';
import { RsvpService } from './rsvp.service';

describe('EventsService', () => {
  let service: EventsService;
  let events: {
    findOne: jest.Mock;
    // `create()` builds its row here before saving it, so the column values a
    // create writes are readable off this mock's calls.
    create: jest.Mock<Event, [Partial<Event>]>;
    save: jest.Mock<Event, [Event]>;
    exists: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let cohosts: { exists: jest.Mock; find: jest.Mock };
  let rsvps: {
    count: jest.Mock;
    findOne: jest.Mock;
    exists: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let invites: { exists: jest.Mock };
  let lineupEntries: { find: jest.Mock };
  // Recurrence: `create` writes one `EventSeries` row and hangs the generated
  // occurrences off it. No test here creates a series, so the default is a
  // repository nothing has written to.
  let eventSeries: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let rsvpService: { reconcileWaitlist: jest.Mock };
  let notifications: { createForRecipients: jest.Mock };
  let blockFilter: { excludeBlocked: jest.Mock };
  let profiles: { find: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };
  let membership: {
    assertOwnerOrModBySlug: jest.Mock;
    isMember: jest.Mock;
    communityIdsForUser: jest.Mock;
    slugById: jest.Mock;
    hostingRefById: jest.Mock;
  };
  let bookmarks: {
    isBookmarked: jest.Mock;
    bookmarkedEventIds: jest.Mock;
    listSaved: jest.Mock;
  };
  // `EventsService` no longer injects `ConnectionsService` directly (fix
  // round 2) — both the per-viewer tier decision (`assertViewable`) and the
  // browse/search list predicate (`scopedVisibilityWhere`) now live on this
  // one shared, separately-injected gate service. `assertViewable` defaults
  // to "always admit" (the invite_only tests below override it to exercise
  // `EventsService`'s OWN responsibility — propagating whatever the gate
  // decides — not re-derive the gate's own tier logic).
  // `scopedVisibilityWhere` defaults to the unscoped "public/members only"
  // clause; no test here exercises `list`/`searchByText`'s scoped branches
  // (that's this file's pre-existing gap, unchanged by this round).
  let audienceGate: {
    assertViewable: jest.Mock;
    scopedVisibilityWhere: jest.Mock;
  };
  // `remove()` announces a hard delete through `emitAsync` and waits for it.
  let eventEmitter: { emitAsync: jest.Mock };

  // A chainable query-builder stub for the RSVP queries: `attendees`'
  // paginated page (`.skip().take().getManyAndCount()`, matching
  // `common/pagination.ts`'s `paginate()`), the detail's
  // `goingAttendeesPreview`, which counts first and then takes a capped slice
  // (`.getCount()` then `.take().getMany()`), and `rosterCounts`, which folds
  // going/seats/waitlist/checked-in into ONE aggregate
  // (`.select().addSelect()….setParameters().getRawOne()`).
  const attendeesQbStub = () => {
    const qb: Record<string, jest.Mock> = {};
    for (const method of [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'setParameters',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
    ]) {
      qb[method] = jest.fn().mockReturnValue(qb);
    }
    qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
    qb.getCount = jest.fn().mockResolvedValue(0);
    qb.getMany = jest.fn().mockResolvedValue([]);
    // `rosterCounts`' single aggregate row: an empty roster by default.
    qb.getRawOne = jest.fn().mockResolvedValue({
      goingCount: '0',
      seatsTaken: '0',
      waitlistCount: '0',
      checkedInCount: '0',
    });
    return qb;
  };

  // The `andWhere` calls carrying the attendees' "Who can see you're going?"
  // predicate (`restrictToAttendeesVisibleTo`), as `[clause, parameters]`.
  const rosterVisibilityCalls = (
    qb: Record<string, jest.Mock>,
  ): Array<[string, Record<string, unknown>]> =>
    (qb.andWhere!.mock.calls as Array<[unknown, Record<string, unknown>]>)
      .filter(
        (call): call is [string, Record<string, unknown>] =>
          typeof call[0] === 'string' && call[0].includes('"r"."visibility"'),
      )
      .map(([clause, parameters]) => [clause, parameters]);

  // One recorded `where` / `andWhere` call: the SQL string AND the parameters
  // bound to it. Both halves matter. A clause naming `:discoveryFrom` proves
  // only what the SQL SAYS; the bound value proves what it will actually
  // compare against, so a predicate handed the wrong Date still fails.
  interface RecordedWhereCall {
    clause: string;
    parameters: Record<string, unknown>;
  }

  // A chainable stub for `list`'s browse query builders. It records every
  // `where` / `andWhere` call it is handed, so a test can read back the exact
  // schedule predicate a branch asked Postgres for and the values it bound.
  // `getMany` resolves empty, which short-circuits `summarize` before any of
  // its per-page lookups.
  const recordingListQueryBuilder = () => {
    const recordedWhereCalls: RecordedWhereCall[] = [];
    const queryBuilder: Record<string, jest.Mock> = {};
    for (const method of ['where', 'andWhere']) {
      queryBuilder[method] = jest.fn((clause: unknown, parameters: unknown) => {
        if (typeof clause === 'string') {
          recordedWhereCalls.push({
            clause,
            parameters:
              parameters && typeof parameters === 'object'
                ? (parameters as Record<string, unknown>)
                : {},
          });
        }
        return queryBuilder;
      });
    }
    for (const method of ['innerJoin', 'orderBy', 'skip', 'take']) {
      queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
    }
    queryBuilder.getMany = jest.fn().mockResolvedValue([]);
    return { queryBuilder, recordedWhereCalls };
  };

  // ONE editable published gathering, hosted by `u1`, starting an hour from
  // now. Every `update` test shares this single factory so the fixtures cannot
  // drift apart; a test needing a different field spreads over it.
  const editableEvent = () => ({
    id: 'e1',
    slug: 'x',
    hostId: 'u1',
    status: EventStatus.Published,
    cost: null,
    visibility: EventVisibility.Public,
    startAt: new Date(Date.now() + 3_600_000),
    endAt: null,
    capacity: null,
    communityId: null,
  });

  beforeEach(async () => {
    events = {
      findOne: jest.fn(),
      // The real repository hands back an entity instance built from the
      // literal; handing the literal straight back keeps the saved row and the
      // recorded call the same object, which is what the create tests read.
      create: jest.fn((entityLike: Partial<Event>) => entityLike as Event),
      save: jest.fn((event: Event) => event),
      exists: jest.fn().mockResolvedValue(false),
      // Series scope (`update`/`cancel` with `scope: 'future'`) resolves the
      // later occurrences with `find`; no test here exercises a series, so the
      // default is "this event has no siblings".
      find: jest.fn().mockResolvedValue([]),
      // `cancel` flips every occurrence in ONE statement rather than saving
      // them one at a time.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      // `remove` hard-deletes the row and lets Postgres cascade the children,
      // so there is nothing here for a child-table mock to observe.
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      // `list`'s browse branches build their query here. The schedule-predicate
      // tests install their own recording stub; the default hands back a
      // builder that returns an empty page.
      createQueryBuilder: jest.fn(
        () => recordingListQueryBuilder().queryBuilder,
      ),
      // `update` runs its patch inside a transaction so a series edit is
      // all-or-nothing. The stub just runs the callback with a manager whose
      // `save` delegates to the same repository mock the non-transactional
      // path uses, so assertions on `events.save` still hold.
      manager: {
        transaction: jest.fn(
          async (runInTransaction: (manager: unknown) => Promise<unknown>) =>
            runInTransaction({
              save: (_entity: unknown, entityLike: Event) =>
                events.save(entityLike),
              getRepository: () => events,
            }),
        ),
      },
    };
    cohosts = {
      exists: jest.fn().mockResolvedValue(false),
      find: jest.fn().mockResolvedValue([]),
    };
    rsvps = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
      exists: jest.fn().mockResolvedValue(false),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => attendeesQbStub()),
    };
    invites = { exists: jest.fn().mockResolvedValue(false) };
    lineupEntries = { find: jest.fn().mockResolvedValue([]) };
    eventSeries = {
      create: jest.fn((entity: unknown) => entity),
      save: jest.fn((entity: object) =>
        Promise.resolve({ id: 'series-1', ...entity }),
      ),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    rsvpService = { reconcileWaitlist: jest.fn().mockResolvedValue(undefined) };
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue(undefined),
    };
    blockFilter = {
      excludeBlocked: jest.fn((qb: unknown) => qb),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    // No moderation takedown by default — every event under test is visible.
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    membership = {
      assertOwnerOrModBySlug: jest.fn().mockResolvedValue('community-1'),
      isMember: jest.fn().mockResolvedValue(false),
      communityIdsForUser: jest.fn().mockResolvedValue([]),
      slugById: jest.fn().mockResolvedValue(null),
      hostingRefById: jest.fn().mockResolvedValue(null),
    };
    bookmarks = {
      isBookmarked: jest.fn().mockResolvedValue(false),
      bookmarkedEventIds: jest.fn().mockResolvedValue(new Set<string>()),
      listSaved: jest.fn().mockResolvedValue([]),
    };
    audienceGate = {
      assertViewable: jest.fn().mockResolvedValue(undefined),
      scopedVisibilityWhere: jest.fn().mockResolvedValue({
        clause: 'e.visibility IN (:...vis)',
        params: { vis: [EventVisibility.Public, EventVisibility.Members] },
      }),
    };
    eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        // `rosterCounts` reads `retention.eventAttendanceDays` to decide
        // whether a check-in count still exists to report. Nothing here
        // overrides it, so the service's own default stands.
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(
              (_key: string, defaultValue?: unknown) => defaultValue,
            ),
          },
        },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventCohost), useValue: cohosts },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvps },
        { provide: getRepositoryToken(EventInvite), useValue: invites },
        {
          provide: getRepositoryToken(EventLineupEntry),
          useValue: lineupEntries,
        },
        { provide: getRepositoryToken(EventSeries), useValue: eventSeries },
        // Host announcements (LOC-06) ride along on an event's detail. No
        // fixture here posts one, so the detail carries an empty list.
        {
          provide: getRepositoryToken(EventAnnouncement),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: UsersService, useValue: { findById: jest.fn() } },
        { provide: RsvpService, useValue: rsvpService },
        { provide: NotificationsService, useValue: notifications },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: ContentModerationService, useValue: contentModeration },
        { provide: CommunityMembershipService, useValue: membership },
        { provide: EventBookmarksService, useValue: bookmarks },
        { provide: EventAudienceGateService, useValue: audienceGate },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        // An event can point at a venue listing; no test here does, so the
        // lookup resolves to "no such live listing".
        {
          provide: ListingLookupService,
          useValue: {
            findLive: jest.fn().mockResolvedValue(null),
            findLinkable: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();
    service = module.get(EventsService);
    // The detail mapper resolves `coverImageUrl` through `toImageUrl`, which
    // throws `Service temporarily unavailable` when the base was never wired.
    // Only fixtures carrying a storage-key cover reach it (the M1
    // foreign-cover cases), which is why it bites those and not the rest.
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  // Attendee lists filter BLOCKS ONLY, never mutes: a mute silences content,
  // it is not an "erase them from the guest list" tool, and misstating who is
  // actually attending could matter for a viewer's own safety planning.
  // Filtering is IN-QUERY (`excludeBlocked`), not post-query, so a page of
  // `PAGE_SIZE` attendees comes back full instead of silently short — and
  // `status` scopes the query to one RSVP status per call (`going`
  // /`waitlisted`), paginated, rather than the whole unbounded guest list.
  describe('attendees', () => {
    const publishedEvent = {
      id: 'e1',
      slug: 'party',
      hostId: 'host-1',
      status: EventStatus.Published,
      cost: null,
      visibility: EventVisibility.Public,
      capacity: 20,
      // `rosterCounts` decides whether a check-in count is still knowable from
      // the gathering's own end (`endAt ?? startAt`) against the attendance
      // retention window, so every fixture that reaches it needs a real date.
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
      // The host left "Show attendee count" on, so a member who is not an
      // organiser reaches the roster query at all.
      showAttendeeCount: true,
    };

    it('filters going attendees by status, in-query and block-excluded', async () => {
      events.findOne.mockResolvedValue(publishedEvent);
      const qb = attendeesQbStub();
      rsvps.createQueryBuilder.mockReturnValue(qb);

      await service.attendees('party', 'viewer-1', 'going');

      expect(qb.andWhere).toHaveBeenCalledWith('r.status = :status', {
        status: 'going',
      });
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        qb,
        'viewer-1',
        '"r"."user_id"',
      );
    });

    it('filters waitlisted attendees separately from going', async () => {
      events.findOne.mockResolvedValue(publishedEvent);
      const qb = attendeesQbStub();
      rsvps.createQueryBuilder.mockReturnValue(qb);

      await service.attendees('party', 'viewer-1', 'waitlisted');

      expect(qb.andWhere).toHaveBeenCalledWith('r.status = :status', {
        status: 'waitlisted',
      });
    });

    it('resolves profiles only for the rows the (block-filtered) query returns, and carries capacity', async () => {
      events.findOne.mockResolvedValue(publishedEvent);
      const qb = attendeesQbStub();
      qb.getManyAndCount!.mockResolvedValue([
        [
          {
            eventId: 'e1',
            userId: 'ok-1',
            status: 'going',
            waitlistPosition: null,
          },
        ],
        1,
      ]);
      rsvps.createQueryBuilder.mockReturnValue(qb);

      const page = await service.attendees('party', 'viewer-1', 'going');

      expect(profiles.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: expect.anything() as unknown },
        }),
      );
      const [{ where }] = profiles.find.mock.calls[0] as [
        { where: { userId: { _value: string[] } } },
      ];
      expect(where.userId._value).toEqual(['ok-1']);
      expect(page.total).toBe(1);
      expect(page.capacity).toBe(20);
    });

    // PRD-414: each attendee's "Who can see you're going?" answer, applied
    // in-query for every viewer who is not an organiser.
    describe('who can see an attendee is going', () => {
      const justMeRow = {
        eventId: 'e1',
        userId: 'quiet-1',
        status: 'going',
        waitlistPosition: null,
        guestCount: 1,
        checkedInAt: null,
        visibility: 'justMe',
        accessNeeds: 'step-free entry',
        dietaryNeeds: 'vegan',
        pronouns: 'they/them',
        customAnswer: 'bringing bread',
      };
      const quietProfile = {
        userId: 'quiet-1',
        slug: 'rui',
        firstName: 'Rui',
        lastName: 'Silva',
        pronouns: null,
        photoVisible: false,
        avatarUrl: null,
      };

      it('restricts a non-organiser to rows whose visibility admits them, including connections', async () => {
        events.findOne.mockResolvedValue(publishedEvent);
        const qb = attendeesQbStub();
        rsvps.createQueryBuilder.mockReturnValue(qb);

        await service.attendees('party', 'stranger-1', 'going');

        const visibilityCalls = rosterVisibilityCalls(qb);
        expect(visibilityCalls).toHaveLength(1);
        const [clause, parameters] = visibilityCalls[0]!;
        // Own row, unset, `everyone`, and `connections` only through an
        // accepted connection in either request direction. `justMe` matches
        // none of these, so it never reaches a stranger or a connection.
        expect(clause).toContain('"r"."user_id" = :attendeeVisibilityViewerId');
        expect(clause).toContain('"r"."visibility" IS NULL');
        expect(clause).toContain(
          '"r"."visibility" = :attendeeVisibilityEveryone',
        );
        expect(clause).toContain(
          '"r"."visibility" = :attendeeVisibilityConnections',
        );
        expect(clause).toContain('FROM "connections"');
        expect(clause).toContain(
          '"__attendee_connection"."requester_id" = :attendeeVisibilityViewerId AND "__attendee_connection"."addressee_id" = "r"."user_id"',
        );
        expect(clause).toContain(
          '"__attendee_connection"."addressee_id" = :attendeeVisibilityViewerId AND "__attendee_connection"."requester_id" = "r"."user_id"',
        );
        expect(clause).not.toContain('justMe');
        expect(parameters).toEqual({
          attendeeVisibilityViewerId: 'stranger-1',
          attendeeVisibilityEveryone: 'everyone',
          attendeeVisibilityConnections: 'connections',
          attendeeVisibilityAccepted: 'accepted',
        });
      });

      it('shows a justMe attendee to the organiser with every note filled', async () => {
        events.findOne.mockResolvedValue(publishedEvent);
        const qb = attendeesQbStub();
        qb.getManyAndCount!.mockResolvedValue([[justMeRow], 1]);
        rsvps.createQueryBuilder.mockReturnValue(qb);
        profiles.find.mockResolvedValue([quietProfile]);

        const page = await service.attendees('party', 'host-1', 'going');

        expect(rosterVisibilityCalls(qb)).toHaveLength(0);
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toEqual(
          expect.objectContaining({
            slug: 'rui',
            guestCount: 1,
            accessNeeds: 'step-free entry',
            dietaryNeeds: 'vegan',
            pronouns: 'they/them',
            customAnswer: 'bringing bread',
            detailsVisibility: 'justMe',
          }),
        );
      });

      it('keeps the going count and seats counting every attendee for a non-organiser', async () => {
        events.findOne.mockResolvedValue(publishedEvent);
        const qb = attendeesQbStub();
        // One row visible to this viewer; the roster holds four members.
        qb.getManyAndCount!.mockResolvedValue([
          [{ ...justMeRow, userId: 'open-1', visibility: 'everyone' }],
          1,
        ]);
        qb.getRawOne!.mockResolvedValue({
          goingCount: '4',
          seatsTaken: '5',
          waitlistCount: '0',
          checkedInCount: '0',
        });
        rsvps.createQueryBuilder.mockReturnValue(qb);
        profiles.find.mockResolvedValue([
          { ...quietProfile, userId: 'open-1' },
        ]);

        const page = await service.attendees('party', 'stranger-1', 'going');

        expect(page.items).toHaveLength(1);
        expect(page.goingCount).toBe(4);
        expect(page.seatsTaken).toBe(5);
        // A non-organiser never receives the notes, whatever the setting.
        expect(page.items[0]!.accessNeeds).toBeUndefined();
      });
    });
  });

  // `EventDetail.goingAttendeesPreview`: faces follow each attendee's
  // "Who can see you're going?" answer, and the total counts everyone.
  describe('going attendees preview', () => {
    const previewEvent = {
      id: 'e1',
      slug: 'party',
      hostId: 'host-1',
      status: EventStatus.Published,
      cost: null,
      visibility: EventVisibility.Public,
      capacity: null,
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
      showAttendeeCount: true,
    };
    const openRow = {
      eventId: 'e1',
      userId: 'open-1',
      status: 'going',
      visibility: 'everyone',
    };

    it('counts hidden attendees in the total and filters faces for a non-organiser', async () => {
      events.findOne.mockResolvedValue(previewEvent);
      const qb = attendeesQbStub();
      // Three going, one of whom this viewer may see.
      qb.getCount!.mockResolvedValue(3);
      qb.getMany!.mockResolvedValue([openRow]);
      rsvps.createQueryBuilder.mockReturnValue(qb);
      profiles.find.mockResolvedValue([
        {
          userId: 'open-1',
          slug: 'ana',
          firstName: 'Ana',
          lastName: 'Silva',
          photoVisible: false,
          avatarUrl: null,
        },
      ]);

      const detail = await service.getBySlug('party', 'stranger-1');

      expect(detail.goingAttendeesPreviewTotal).toBe(3);
      expect(detail.goingAttendeesPreview).toHaveLength(1);
      const visibilityCalls = rosterVisibilityCalls(qb);
      expect(visibilityCalls).toHaveLength(1);
      expect(visibilityCalls[0]![1]).toEqual(
        expect.objectContaining({ attendeeVisibilityViewerId: 'stranger-1' }),
      );
      // The total is read before the visibility filter joins the query.
      const visibilityCallOrder =
        qb.andWhere!.mock.invocationCallOrder[
          qb.andWhere!.mock.calls.findIndex(
            ([clause]) =>
              typeof clause === 'string' && clause.includes('"r"."visibility"'),
          )
        ]!;
      expect(qb.getCount!.mock.invocationCallOrder[0]).toBeLessThan(
        visibilityCallOrder,
      );
    });

    it('shows the organiser every going attendee', async () => {
      events.findOne.mockResolvedValue(previewEvent);
      const qb = attendeesQbStub();
      qb.getCount!.mockResolvedValue(1);
      qb.getMany!.mockResolvedValue([{ ...openRow, visibility: 'justMe' }]);
      rsvps.createQueryBuilder.mockReturnValue(qb);

      await service.getBySlug('party', 'host-1');

      expect(rosterVisibilityCalls(qb)).toHaveLength(0);
    });
  });

  // The door list CSV carries what attendees typed into their RSVP details.
  // It follows the organiser's dashboard view, so every answer is filled
  // whatever the attendee picked for "Who can see you're going?".
  describe('attendeesCsv', () => {
    const hostedEvent = {
      id: 'e1',
      slug: 'party',
      hostId: 'host-1',
      status: EventStatus.Published,
    };
    const rsvpRow = (userId: string, visibility: 'justMe' | null) => ({
      eventId: 'e1',
      userId,
      status: 'going',
      waitlistPosition: null,
      guestCount: 0,
      createdAt: new Date('2026-09-01T10:00:00.000Z'),
      checkedInAt: null,
      visibility,
      accessNeeds: `${userId} step-free entry`,
      dietaryNeeds: `${userId} vegan`,
      pronouns: `${userId} they/them`,
      customAnswer: `${userId} bringing bread`,
    });
    const profileFor = (userId: string, firstName: string) => ({
      userId,
      firstName,
      lastName: 'Silva',
      pronouns: null,
      photoVisible: false,
      avatarUrl: null,
    });

    it('fills every free-text answer, for a justMe attendee too', async () => {
      events.findOne.mockResolvedValue(hostedEvent);
      rsvps.find.mockResolvedValue([
        rsvpRow('shared-1', null),
        rsvpRow('private-1', 'justMe'),
      ]);
      profiles.find.mockResolvedValue([
        profileFor('shared-1', 'Ana'),
        profileFor('private-1', 'Rui'),
      ]);

      const csv = await service.attendeesCsv('party', 'host-1');
      const [header, sharedLine, privateLine] = csv.split('\n');

      expect(header).toContain('"rsvp pronouns","custom answer"');
      expect(sharedLine).toContain('"shared-1 step-free entry"');
      expect(sharedLine).toContain('"shared-1 vegan"');
      expect(sharedLine).toContain('"shared-1 they/them"');
      expect(sharedLine).toContain('"shared-1 bringing bread"');
      expect(privateLine).toContain('"Rui Silva"');
      expect(privateLine).toContain('"private-1 step-free entry"');
      expect(privateLine).toContain('"private-1 vegan"');
      expect(privateLine).toContain('"private-1 they/them"');
      expect(privateLine).toContain('"private-1 bringing bread"');
    });
  });

  // Section 7, M1: the named attendee lists leave out members whose account
  // is suspended, deactivated or pending deletion, for every viewer,
  // organisers included, because by-name check-in answers "Member not found"
  // for them. Counts and totals keep counting everybody.
  describe('named attendee lists hold active accounts only', () => {
    const rosterEvent = {
      id: 'e1',
      slug: 'party',
      hostId: 'host-1',
      status: EventStatus.Published,
      cost: null,
      visibility: EventVisibility.Public,
      capacity: 20,
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
      showAttendeeCount: true,
    };

    // The `andWhere` calls carrying the active-account predicate, as
    // `[clause, parameters]`.
    const activeAccountCalls = (
      qb: Record<string, jest.Mock>,
    ): Array<[string, Record<string, unknown>]> =>
      (qb.andWhere!.mock.calls as Array<[unknown, Record<string, unknown>]>)
        .filter(
          (call): call is [string, Record<string, unknown>] =>
            typeof call[0] === 'string' &&
            call[0].includes('"__attendee_account"'),
        )
        .map(([clause, parameters]) => [clause, parameters]);

    const expectActiveAccountClause = (
      clause: string,
      userIdColumn: string,
    ) => {
      expect(clause).toContain('FROM "users" "__attendee_account"');
      expect(clause).toContain(
        `"__attendee_account"."id" = ${userIdColumn} AND "__attendee_account"."status" = :attendeeAccountActive`,
      );
    };

    it.each([
      ['an organiser', 'host-1'],
      ['a member', 'stranger-1'],
    ])(
      'joins the active-account predicate into the paged roster for %s',
      async (_viewerLabel, viewerId) => {
        events.findOne.mockResolvedValue(rosterEvent);
        const qb = attendeesQbStub();
        rsvps.createQueryBuilder.mockReturnValue(qb);

        await service.attendees('party', viewerId, 'going');

        const calls = activeAccountCalls(qb);
        expect(calls).toHaveLength(1);
        const [clause, parameters] = calls[0]!;
        expectActiveAccountClause(clause, '"r"."user_id"');
        expect(parameters).toEqual({ attendeeAccountActive: 'active' });
        // In-query, ahead of the page read, so a page comes back full.
        const clauseOrder =
          qb.andWhere!.mock.invocationCallOrder[
            qb.andWhere!.mock.calls.findIndex(
              ([candidate]) =>
                typeof candidate === 'string' &&
                candidate.includes('"__attendee_account"'),
            )
          ]!;
        expect(clauseOrder).toBeLessThan(
          qb.getManyAndCount!.mock.invocationCallOrder[0]!,
        );
      },
    );

    it('keeps the organiser roster counts counting every attendee', async () => {
      events.findOne.mockResolvedValue(rosterEvent);
      const qb = attendeesQbStub();
      qb.getRawOne!.mockResolvedValue({
        goingCount: '3',
        seatsTaken: '3',
        waitlistCount: '0',
        checkedInCount: '1',
      });
      rsvps.createQueryBuilder.mockReturnValue(qb);

      const page = await service.attendees('party', 'host-1', 'going');

      expect(page.goingCount).toBe(3);
      expect(page.seatsTaken).toBe(3);
      expect(page.checkedInCount).toBe(1);
    });

    it.each([
      ['an organiser', 'host-1'],
      ['a member', 'stranger-1'],
    ])(
      'filters preview faces after the total is counted for %s',
      async (_viewerLabel, viewerId) => {
        events.findOne.mockResolvedValue(rosterEvent);
        const qb = attendeesQbStub();
        qb.getCount!.mockResolvedValue(3);
        qb.getMany!.mockResolvedValue([
          {
            eventId: 'e1',
            userId: 'open-1',
            status: 'going',
            visibility: 'everyone',
          },
        ]);
        rsvps.createQueryBuilder.mockReturnValue(qb);
        profiles.find.mockResolvedValue([
          {
            userId: 'open-1',
            slug: 'ana',
            firstName: 'Ana',
            lastName: 'Silva',
            photoVisible: false,
            avatarUrl: null,
          },
        ]);

        const detail = await service.getBySlug('party', viewerId);

        expect(detail.goingAttendeesPreviewTotal).toBe(3);
        expect(detail.goingAttendeesPreview).toHaveLength(1);
        const calls = activeAccountCalls(qb);
        expect(calls).toHaveLength(1);
        expectActiveAccountClause(calls[0]![0], '"r"."user_id"');
        const clauseOrder =
          qb.andWhere!.mock.invocationCallOrder[
            qb.andWhere!.mock.calls.findIndex(
              ([candidate]) =>
                typeof candidate === 'string' &&
                candidate.includes('"__attendee_account"'),
            )
          ]!;
        expect(qb.getCount!.mock.invocationCallOrder[0]).toBeLessThan(
          clauseOrder,
        );
        expect(clauseOrder).toBeLessThan(
          qb.getMany!.mock.invocationCallOrder[0]!,
        );
      },
    );

    it('reads the CSV door list through the active-account predicate', async () => {
      events.findOne.mockResolvedValue(rosterEvent);

      await service.attendeesCsv('party', 'host-1');

      const [{ where }] = rsvps.find.mock.calls[0] as [
        {
          where: {
            userId: {
              type: string;
              getSql?: (column: string) => string;
              objectLiteralParameters?: Record<string, unknown>;
            };
          };
        },
      ];
      expect(where.userId.type).toBe('raw');
      expectActiveAccountClause(
        where.userId.getSql!('EventRsvp.userId'),
        'EventRsvp.userId',
      );
      expect(where.userId.objectLiteralParameters).toEqual({
        attendeeAccountActive: 'active',
      });
    });
  });

  it('isOrganizer is true for the host', async () => {
    events.findOne.mockResolvedValue({ id: 'e1', hostId: 'u1' });
    await expect(service.isOrganizer('e1', 'u1')).resolves.toBe(true);
  });

  it('isOrganizer falls back to the co-host check', async () => {
    events.findOne.mockResolvedValue({ id: 'e1', hostId: 'host' });
    cohosts.exists.mockResolvedValue(true);
    await expect(service.isOrganizer('e1', 'u2')).resolves.toBe(true);
  });

  it('update rejects a non-organizer', async () => {
    events.findOne.mockResolvedValue({ id: 'e1', slug: 'x', hostId: 'host' });
    cohosts.exists.mockResolvedValue(false);
    await expect(
      service.update('x', 'intruder', { title: 'new' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('getBySlug 404s an unknown slug', async () => {
    events.findOne.mockResolvedValue(null);
    await expect(service.getBySlug('nope', 'u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getBySlug hides a draft from non-organizers (404)', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'd',
      hostId: 'host',
      status: EventStatus.Draft,
      cost: null,
      visibility: EventVisibility.Public,
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
    });
    cohosts.exists.mockResolvedValue(false);
    await expect(service.getBySlug('d', 'viewer')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getBySlug shows a draft to its organizer', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'd',
      hostId: 'host',
      status: EventStatus.Draft,
      cost: null,
      visibility: EventVisibility.Public,
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
    });
    const detail = await service.getBySlug('d', 'host');
    expect(detail.isOrganizer).toBe(true);
  });

  // The invite_only ALLOW/DENY decision itself now lives in
  // `EventAudienceGateService` (fix round 1's shared gate — also used by
  // `RsvpService`'s RSVP path). `EventsService`'s own responsibility is
  // narrower: run the moderation/draft checks, then propagate whatever the
  // gate decides — which is what these two tests exercise, driving the
  // mocked gate directly instead of the (no-longer-consulted-here)
  // `invites`/`rsvps` repos.
  it('getBySlug hides an invite_only event from a stranger (404)', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'io',
      hostId: 'host',
      status: EventStatus.Published,
      cost: null,
      visibility: EventVisibility.InviteOnly,
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
    });
    cohosts.exists.mockResolvedValue(false);
    audienceGate.assertViewable.mockRejectedValue(
      new NotFoundException('Event not found'),
    );
    await expect(service.getBySlug('io', 'stranger')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audienceGate.assertViewable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1' }),
      'stranger',
      false,
    );
  });

  it('getBySlug shows an invite_only event to an invitee', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'io',
      hostId: 'host',
      status: EventStatus.Published,
      cost: null,
      visibility: EventVisibility.InviteOnly,
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
    });
    cohosts.exists.mockResolvedValue(false);
    audienceGate.assertViewable.mockResolvedValue(undefined);
    const detail = await service.getBySlug('io', 'invited-user');
    expect(detail.slug).toBe('io');
    expect(audienceGate.assertViewable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1' }),
      'invited-user',
      false,
    );
  });

  it('update rejects reopening a cancelled event (409)', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'x',
      hostId: 'u1',
      status: EventStatus.Cancelled,
      cost: null,
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
      capacity: null,
    });
    await expect(
      service.update('x', 'u1', { status: EventStatus.Published }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('update reconciles the waitlist when capacity grows', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'x',
      hostId: 'u1',
      status: EventStatus.Published,
      cost: null,
      visibility: EventVisibility.Public,
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
      capacity: 2,
    });
    await service.update('x', 'u1', { capacity: 5 });
    expect(rsvpService.reconcileWaitlist).toHaveBeenCalledWith('x');
  });

  it('update does not reconcile when capacity shrinks', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'x',
      hostId: 'u1',
      status: EventStatus.Published,
      cost: null,
      visibility: EventVisibility.Public,
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
      capacity: 5,
    });
    await service.update('x', 'u1', { capacity: 2 });
    expect(rsvpService.reconcileWaitlist).not.toHaveBeenCalled();
  });

  // M1 (storage-key impersonation): the event cover is a shared-upload surface
  // (cohosts edit the same event), so the interceptor exempts it and the service
  // draws the line — a foreign cover key is allowed only when it is already the
  // stored value (a cohost's no-op re-save); pointing the field at a NEW foreign
  // upload is refused.
  describe('foreign cover ownership (M1)', () => {
    const OTHER_ID = '22222222-2222-2222-2222-222222222222';
    const FILE_SEGMENT = '33333333-3333-3333-3333-333333333333';
    const FOREIGN_COVER = `story-covers/${OTHER_ID}/${FILE_SEGMENT}.jpg`;
    const baseEvent = (coverImageUrl: string | null) => ({
      id: 'e1',
      slug: 'x',
      hostId: 'host',
      status: EventStatus.Published,
      cost: null,
      visibility: EventVisibility.Public,
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
      capacity: null,
      communityId: null,
      coverImageUrl,
    });

    it('lets a cohost re-save the unchanged foreign cover already stored', async () => {
      events.findOne.mockResolvedValue(baseEvent(FOREIGN_COVER));
      cohosts.exists.mockResolvedValue(true);
      await expect(
        service.update('x', 'cohost-1', { coverImageUrl: FOREIGN_COVER }),
      ).resolves.toBeDefined();
    });

    it('rejects a cohost introducing a new foreign cover key', async () => {
      events.findOne.mockResolvedValue(baseEvent(null));
      cohosts.exists.mockResolvedValue(true);
      await expect(
        service.update('x', 'cohost-1', { coverImageUrl: FOREIGN_COVER }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // Fix round 2 (Task C): `update()` can now resolve/detach a community via
  // `communitySlug`, mirroring `create()`'s handling exactly — same
  // authorization check (`assertOwnerOrModBySlug`), applied to the acting
  // organizer (`userId`) rather than always `hostId`.
  describe('update communitySlug handling', () => {
    it('resolves a non-empty communitySlug via the SAME authorization create() uses', async () => {
      events.findOne.mockResolvedValue(editableEvent());
      membership.assertOwnerOrModBySlug.mockResolvedValue('community-9');
      const detail = await service.update('x', 'u1', {
        communitySlug: 'queer-devs',
      });
      expect(membership.assertOwnerOrModBySlug).toHaveBeenCalledWith(
        'queer-devs',
        'u1',
      );
      expect(detail.communityId).toBe('community-9');
    });

    it('detaches the community when communitySlug is explicitly null', async () => {
      events.findOne.mockResolvedValue({
        ...editableEvent(),
        communityId: 'community-9',
      });
      const detail = await service.update('x', 'u1', { communitySlug: null });
      expect(membership.assertOwnerOrModBySlug).not.toHaveBeenCalled();
      expect(detail.communityId).toBeNull();
    });

    it('detaches the community when communitySlug is an empty string', async () => {
      events.findOne.mockResolvedValue({
        ...editableEvent(),
        communityId: 'community-9',
      });
      const detail = await service.update('x', 'u1', { communitySlug: '' });
      expect(detail.communityId).toBeNull();
    });

    it('leaves communityId unchanged when communitySlug is absent from the patch', async () => {
      events.findOne.mockResolvedValue({
        ...editableEvent(),
        communityId: 'community-9',
      });
      const detail = await service.update('x', 'u1', { capacity: 3 });
      expect(membership.assertOwnerOrModBySlug).not.toHaveBeenCalled();
      expect(detail.communityId).toBe('community-9');
    });

    it('400s when detaching the community while visibility stays community', async () => {
      events.findOne.mockResolvedValue({
        ...editableEvent(),
        visibility: EventVisibility.Community,
        communityId: 'community-9',
      });
      await expect(
        service.update('x', 'u1', { communitySlug: null }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400s when switching visibility to community with no resolved community', async () => {
      events.findOne.mockResolvedValue(editableEvent()); // communityId: null
      await expect(
        service.update('x', 'u1', { visibility: EventVisibility.Community }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('keeps the community it is already hosted with without re-checking standing', async () => {
      events.findOne.mockResolvedValue({
        ...editableEvent(),
        communityId: 'community-9',
      });
      membership.slugById.mockResolvedValue('queer-devs');
      const detail = await service.update('x', 'u1', {
        communitySlug: 'queer-devs',
      });
      expect(membership.assertOwnerOrModBySlug).not.toHaveBeenCalled();
      expect(detail.communityId).toBe('community-9');
    });

    it('refuses a move to another community the organizer cannot speak for', async () => {
      events.findOne.mockResolvedValue({
        ...editableEvent(),
        communityId: 'community-9',
      });
      membership.slugById.mockResolvedValue('queer-devs');
      membership.assertOwnerOrModBySlug.mockRejectedValue(
        new ForbiddenException(),
      );
      await expect(
        service.update('x', 'u1', { communitySlug: 'lisbon-hikers' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(membership.assertOwnerOrModBySlug).toHaveBeenCalledWith(
        'lisbon-hikers',
        'u1',
      );
    });
  });

  // `EventDetail.community`: the community a gathering is hosted with, shown
  // on its page whatever its visibility, except a `private` community to a
  // viewer outside it.
  describe('getBySlug hosting community', () => {
    const hostedEvent = () => ({
      ...editableEvent(),
      hostId: 'host',
      communityId: 'community-9',
    });
    const ref = (accessTier: AccessTier) => ({
      slug: 'queer-devs',
      name: 'Queer Devs',
      accessTier,
    });

    it('names a listed community to anyone who can see the gathering', async () => {
      events.findOne.mockResolvedValue(hostedEvent());
      membership.hostingRefById.mockResolvedValue(ref(AccessTier.Request));
      const detail = await service.getBySlug('x', 'stranger');
      expect(detail.community).toEqual(ref(AccessTier.Request));
      expect(detail.communitySlug).toBe('queer-devs');
      expect(detail.communityId).toBe('community-9');
      expect(membership.isMember).not.toHaveBeenCalled();
    });

    it('withholds a private community, slug and id included, from an outsider', async () => {
      events.findOne.mockResolvedValue(hostedEvent());
      membership.hostingRefById.mockResolvedValue(ref(AccessTier.Private));
      membership.isMember.mockResolvedValue(false);
      const detail = await service.getBySlug('x', 'stranger');
      expect(detail.community).toBeNull();
      expect(detail.communitySlug).toBeNull();
      expect(detail.communityId).toBeNull();
    });

    it('names a private community to its own members', async () => {
      events.findOne.mockResolvedValue(hostedEvent());
      membership.hostingRefById.mockResolvedValue(ref(AccessTier.Private));
      membership.isMember.mockResolvedValue(true);
      const detail = await service.getBySlug('x', 'member');
      expect(detail.community).toEqual(ref(AccessTier.Private));
      expect(membership.isMember).toHaveBeenCalledWith('community-9', 'member');
    });

    it('names a private community to the organizers, member or not', async () => {
      events.findOne.mockResolvedValue(hostedEvent());
      membership.hostingRefById.mockResolvedValue(ref(AccessTier.Private));
      const detail = await service.getBySlug('x', 'host');
      expect(detail.community).toEqual(ref(AccessTier.Private));
      expect(detail.communityId).toBe('community-9');
    });

    it('carries no community for a gathering without one', async () => {
      events.findOne.mockResolvedValue(editableEvent());
      const detail = await service.getBySlug('x', 'u1');
      expect(detail.community).toBeNull();
      expect(membership.hostingRefById).not.toHaveBeenCalled();
    });
  });

  // Multi-day and overnight gatherings. A gathering that is UNDERWAY belongs in
  // 'upcoming', and the two browse branches have to partition time between them
  // so nothing lands in both lists or in neither.
  //
  // These tests have no database, so they work in two steps. `scheduleClauseFor`
  // reads back the exact SQL string the service handed the query builder, and
  // `matchesScheduleClause` pins what that string MEANS by stating the same
  // logic in JavaScript. A predicate the service changes without changing these
  // constants fails the first test; a predicate whose meaning drifts fails the
  // ones after it.
  describe('list schedule predicates', () => {
    const UPCOMING_SCHEDULE_CLAUSE =
      '(e.start_at >= :now OR (e.end_at IS NOT NULL AND e.end_at >= :now))';
    const PAST_SCHEDULE_CLAUSE =
      '(e.start_at < :now AND (e.end_at IS NULL OR e.end_at < :now))';

    const matchesScheduleClause = (
      clause: string,
      gathering: { startAt: Date; endAt: Date | null },
      now: Date,
    ): boolean => {
      const startsAt = gathering.startAt.getTime();
      const endsAt = gathering.endAt ? gathering.endAt.getTime() : null;
      const nowInMilliseconds = now.getTime();
      if (clause === UPCOMING_SCHEDULE_CLAUSE) {
        return (
          startsAt >= nowInMilliseconds ||
          (endsAt !== null && endsAt >= nowInMilliseconds)
        );
      }
      if (clause === PAST_SCHEDULE_CLAUSE) {
        return (
          startsAt < nowInMilliseconds &&
          (endsAt === null || endsAt < nowInMilliseconds)
        );
      }
      throw new Error(`No JavaScript reading for the clause: ${clause}`);
    };

    // Runs the branch and returns the one call it built around `:now`, having
    // first checked that the `now` it bound is a real Date.
    const scheduleCallFor = async (
      filter: 'upcoming' | 'past',
    ): Promise<RecordedWhereCall> => {
      const { queryBuilder, recordedWhereCalls } = recordingListQueryBuilder();
      events.createQueryBuilder.mockReturnValue(queryBuilder);
      await service.list('viewer-1', filter, 1);
      const scheduleCalls = recordedWhereCalls.filter((call) =>
        call.clause.includes(':now'),
      );
      expect(scheduleCalls).toHaveLength(1);
      expect(scheduleCalls[0]!.parameters.now).toBeInstanceOf(Date);
      return scheduleCalls[0]!;
    };

    const scheduleClauseFor = async (
      filter: 'upcoming' | 'past',
    ): Promise<string> => (await scheduleCallFor(filter)).clause;

    const now = new Date('2026-10-17T23:30:00.000Z');
    const HOUR_IN_MILLISECONDS = 3_600_000;
    const running = {
      startAt: new Date(now.getTime() - HOUR_IN_MILLISECONDS),
      endAt: new Date(now.getTime() + 3 * HOUR_IN_MILLISECONDS),
    };
    const finished = {
      startAt: new Date(now.getTime() - 4 * HOUR_IN_MILLISECONDS),
      endAt: new Date(now.getTime() - HOUR_IN_MILLISECONDS),
    };
    const startedWithNoStatedEnd = {
      startAt: new Date(now.getTime() - HOUR_IN_MILLISECONDS),
      endAt: null,
    };

    it('builds the underway-aware predicate for upcoming and its inverse for past', async () => {
      await expect(scheduleClauseFor('upcoming')).resolves.toBe(
        UPCOMING_SCHEDULE_CLAUSE,
      );
      await expect(scheduleClauseFor('past')).resolves.toBe(
        PAST_SCHEDULE_CLAUSE,
      );
    });

    it('keeps a gathering that started an hour ago and ends in three in upcoming, and out of past', async () => {
      const upcomingClause = await scheduleClauseFor('upcoming');
      const pastClause = await scheduleClauseFor('past');
      expect(matchesScheduleClause(upcomingClause, running, now)).toBe(true);
      expect(matchesScheduleClause(pastClause, running, now)).toBe(false);
    });

    it('moves a gathering that ended an hour ago into past, and out of upcoming', async () => {
      const upcomingClause = await scheduleClauseFor('upcoming');
      const pastClause = await scheduleClauseFor('past');
      expect(matchesScheduleClause(pastClause, finished, now)).toBe(true);
      expect(matchesScheduleClause(upcomingClause, finished, now)).toBe(false);
    });

    // `hasEnded` in `event-timing.ts` reads a null `endAt` strictly: a
    // gathering that states no end is over once it has started. Browse agrees
    // on exactly that case, which is what this test proves. Where an end IS
    // stated the two differ for one instant: at `end_at == now` browse still
    // says upcoming while `hasEnded`'s `<=` already says ended. Both operators
    // were specified deliberately, so that instant is left alone here.
    it('counts a started gathering with no stated end as past', async () => {
      const upcomingClause = await scheduleClauseFor('upcoming');
      const pastClause = await scheduleClauseFor('past');
      expect(
        matchesScheduleClause(pastClause, startedWithNoStatedEnd, now),
      ).toBe(true);
      expect(
        matchesScheduleClause(upcomingClause, startedWithNoStatedEnd, now),
      ).toBe(false);
    });
  });

  // The "Today" / "This weekend" / "This week" chips, which reach the server as
  // an optional `from` and an optional `to` (`whenPresetRange` in the
  // frontend's `hub/browseFilters.ts`). A window is an INTERVAL, so the
  // question is intersection: the gathering has to start at or before the
  // window's end AND end at or after the window's start, reading a null end as
  // ending at its own start. Asked point-in-time against `start_at` alone,
  // "Today" dropped a festival that was running right then.
  //
  // Same two-step as the schedule predicates above: read back the SQL the
  // service built, then pin what it MEANS in JavaScript.
  describe('discovery window bounds', () => {
    const FROM_CLAUSE =
      '(e.start_at >= :discoveryFrom OR (e.end_at IS NOT NULL AND e.end_at >= :discoveryFrom))';
    const TO_CLAUSE = 'e.start_at <= :discoveryTo';

    // Every window call the branch built, in the order it built them, SQL and
    // bound parameters together.
    const windowCallsFor = async (options: {
      from?: string;
      to?: string;
    }): Promise<RecordedWhereCall[]> => {
      const { queryBuilder, recordedWhereCalls } = recordingListQueryBuilder();
      events.createQueryBuilder.mockReturnValue(queryBuilder);
      await service.list('viewer-1', 'upcoming', 1, options);
      return recordedWhereCalls.filter(
        (call) =>
          call.clause.includes(':discoveryFrom') ||
          call.clause.includes(':discoveryTo'),
      );
    };

    const windowClausesFor = async (options: {
      from?: string;
      to?: string;
    }): Promise<string[]> =>
      (await windowCallsFor(options)).map((call) => call.clause);

    // Reads each recorded call against a gathering using the value the service
    // ACTUALLY bound, so a clause handed the wrong Date fails here rather than
    // passing on the strength of its SQL text.
    const matchesWindowCalls = (
      calls: RecordedWhereCall[],
      gathering: { startAt: Date; endAt: Date | null },
    ): boolean =>
      calls.every((call) => {
        const startsAt = gathering.startAt.getTime();
        const endsAt = gathering.endAt ? gathering.endAt.getTime() : null;
        if (call.clause === FROM_CLAUSE) {
          const boundFrom = call.parameters.discoveryFrom;
          expect(boundFrom).toBeInstanceOf(Date);
          const fromMilliseconds = (boundFrom as Date).getTime();
          return (
            startsAt >= fromMilliseconds ||
            (endsAt !== null && endsAt >= fromMilliseconds)
          );
        }
        if (call.clause === TO_CLAUSE) {
          const boundTo = call.parameters.discoveryTo;
          expect(boundTo).toBeInstanceOf(Date);
          return startsAt <= (boundTo as Date).getTime();
        }
        throw new Error(`No JavaScript reading for the clause: ${call.clause}`);
      });

    // "Today" as the frontend builds it: now through the end of the day.
    const from = new Date('2026-10-18T09:00:00.000Z');
    const to = new Date('2026-10-18T23:59:59.999Z');
    const todayWindow = { from: from.toISOString(), to: to.toISOString() };

    const DAY_IN_MILLISECONDS = 86_400_000;
    // Day two of a three-day festival: it began yesterday and runs to tomorrow.
    const runningFestival = {
      startAt: new Date(from.getTime() - DAY_IN_MILLISECONDS),
      endAt: new Date(to.getTime() + DAY_IN_MILLISECONDS),
    };
    // An overnight party that ended at 04:00 this morning, before the window.
    const endedBeforeTheWindow = {
      startAt: new Date(from.getTime() - 12 * DAY_IN_MILLISECONDS),
      endAt: new Date(from.getTime() - 3_600_000),
    };
    // Inside the window, stating no end at all.
    const insideWithNoStatedEnd = {
      startAt: new Date(from.getTime() + 3_600_000),
      endAt: null,
    };
    // Starts the day after the window closes, stating no end.
    const afterWithNoStatedEnd = {
      startAt: new Date(to.getTime() + DAY_IN_MILLISECONDS),
      endAt: null,
    };

    it('bounds the window by intersection rather than by the start alone', async () => {
      await expect(windowClausesFor(todayWindow)).resolves.toEqual([
        FROM_CLAUSE,
        TO_CLAUSE,
      ]);
    });

    // The chips send ISO strings. What the builder must receive is the parsed
    // instant for each, bound to its own parameter and neither swapped for the
    // other.
    it('binds the parsed window instants, each to its own parameter', async () => {
      const calls = await windowCallsFor(todayWindow);
      const [fromCall, toCall] = calls;
      expect(fromCall!.parameters).toEqual({ discoveryFrom: from });
      expect(toCall!.parameters).toEqual({ discoveryTo: to });
    });

    it('keeps a festival that started before today and is still running', async () => {
      const calls = await windowCallsFor(todayWindow);
      expect(matchesWindowCalls(calls, runningFestival)).toBe(true);
    });

    it('drops a gathering that ended before the window opened', async () => {
      const calls = await windowCallsFor(todayWindow);
      expect(matchesWindowCalls(calls, endedBeforeTheWindow)).toBe(false);
    });

    it('treats a gathering with no stated end as a point in time', async () => {
      const calls = await windowCallsFor(todayWindow);
      expect(matchesWindowCalls(calls, insideWithNoStatedEnd)).toBe(true);
      expect(matchesWindowCalls(calls, afterWithNoStatedEnd)).toBe(false);
    });

    // The two bounds are supplied independently, so each combination has to
    // mean something on its own: `to` alone is an upper bound on the start,
    // `from` alone is a lower bound on the end, and neither leaves the range
    // open.
    it('applies each bound independently', async () => {
      await expect(
        windowClausesFor({ from: todayWindow.from }),
      ).resolves.toEqual([FROM_CLAUSE]);
      await expect(windowClausesFor({ to: todayWindow.to })).resolves.toEqual([
        TO_CLAUSE,
      ]);
      await expect(windowClausesFor({})).resolves.toEqual([]);
    });

    it('still finds a running festival with only the window start given', async () => {
      const calls = await windowCallsFor({ from: todayWindow.from });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.parameters).toEqual({ discoveryFrom: from });
      expect(matchesWindowCalls(calls, runningFestival)).toBe(true);
      expect(matchesWindowCalls(calls, endedBeforeTheWindow)).toBe(false);
    });

    it('ignores an unparseable bound instead of filtering on NaN', async () => {
      await expect(
        windowClausesFor({ from: 'not a date', to: 'nor this' }),
      ).resolves.toEqual([]);
    });
  });

  // The 14-day ceiling on a single gathering's span, mirrored client-side by
  // `MAX_GATHERING_SPAN_DAYS` in the wizard. `update` and `create` share one
  // `assertScheduleValid`, so exercising the edit path covers both.
  describe('maximum gathering span', () => {
    const DAY_IN_MILLISECONDS = 86_400_000;
    const startAt = '2026-10-17T21:00:00.000Z';
    const endAfterDays = (days: number) =>
      new Date(Date.parse(startAt) + days * DAY_IN_MILLISECONDS).toISOString();
    // The shared fixture, pinned to a fixed start so the span arithmetic
    // below reads off one known instant.
    const storedEvent = () => ({
      ...editableEvent(),
      startAt: new Date(startAt),
    });

    it('accepts a fourteen-day span', async () => {
      events.findOne.mockResolvedValue(storedEvent());
      await expect(
        service.update('x', 'u1', { startAt, endAt: endAfterDays(14) }),
      ).resolves.toBeDefined();
    });

    it('rejects a fifteen-day span and names the limit', async () => {
      events.findOne.mockResolvedValue(storedEvent());
      await expect(
        service.update('x', 'u1', { startAt, endAt: endAfterDays(15) }),
      ).rejects.toThrow(/14 days/);
      events.findOne.mockResolvedValue(storedEvent());
      await expect(
        service.update('x', 'u1', { startAt, endAt: endAfterDays(15) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('still rejects an end that is not after the start', async () => {
      events.findOne.mockResolvedValue(storedEvent());
      await expect(
        service.update('x', 'u1', { startAt, endAt: startAt }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('cancel notifies going/maybe/waitlisted RSVPs, excluding the organizer', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'party',
      hostId: 'host',
      status: EventStatus.Published,
      cost: null,
      startAt: new Date('2030-01-01T00:00:00.000Z'),
      title: 'Party',
    });
    rsvps.find.mockResolvedValue([
      { userId: 'a' },
      { userId: 'b' },
      { userId: 'host' }, // organizer's own RSVP — must be excluded
    ]);
    await service.cancel('party', 'host');
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['a', 'b'],
      NotificationType.EventCancelled,
      expect.objectContaining({ eventId: 'e1' }),
    );
  });

  // Hard delete is the narrow door beside `cancel`. It is the HOST's alone
  // (a co-host may call a gathering off, and only its owner may destroy the
  // record), and it stays shut while anyone still has a stake, because a
  // delete notifies nobody and leaves nothing to link to.
  describe('remove', () => {
    const cancelledEvent = {
      id: 'e1',
      slug: 'party',
      hostId: 'host',
      status: EventStatus.Cancelled,
    };
    const publishedEvent = {
      id: 'e1',
      slug: 'party',
      hostId: 'host',
      status: EventStatus.Published,
    };

    it('lets the host delete an already-cancelled event even with attendees', async () => {
      events.findOne.mockResolvedValue(cancelledEvent);
      // Attendees are irrelevant here: they were told when it was cancelled,
      // so the stake check is never reached.
      rsvps.count.mockResolvedValue(4);
      await expect(service.remove('party', 'host')).resolves.toEqual({
        ok: true,
      });
      expect(events.delete).toHaveBeenCalledWith({ id: 'e1' });
      expect(rsvps.count).not.toHaveBeenCalled();
    });

    it('lets the host delete a published event nobody has signed up to', async () => {
      events.findOne.mockResolvedValue(publishedEvent);
      rsvps.count.mockResolvedValue(0);
      invites.exists.mockResolvedValue(false);
      await expect(service.remove('party', 'host')).resolves.toEqual({
        ok: true,
      });
      expect(events.delete).toHaveBeenCalledWith({ id: 'e1' });
    });

    it('409s a published event that still has a going RSVP', async () => {
      events.findOne.mockResolvedValue(publishedEvent);
      rsvps.count.mockResolvedValue(1);
      await expect(service.remove('party', 'host')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(events.delete).not.toHaveBeenCalled();
    });

    it('409s a published event that still has a pending invite', async () => {
      events.findOne.mockResolvedValue(publishedEvent);
      rsvps.count.mockResolvedValue(0);
      invites.exists.mockResolvedValue(true);
      await expect(service.remove('party', 'host')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(events.delete).not.toHaveBeenCalled();
    });

    it('rejects a co-host, who may cancel but may never delete', async () => {
      events.findOne.mockResolvedValue(publishedEvent);
      cohosts.exists.mockResolvedValue(true);
      await expect(service.remove('party', 'cohost')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(events.delete).not.toHaveBeenCalled();
    });

    it('rejects a stranger', async () => {
      events.findOne.mockResolvedValue(publishedEvent);
      await expect(service.remove('party', 'intruder')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(events.delete).not.toHaveBeenCalled();
    });

    it('404s an unknown slug', async () => {
      events.findOne.mockResolvedValue(null);
      await expect(service.remove('nope', 'host')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(events.delete).not.toHaveBeenCalled();
    });

    // ENG-433: the cascade removes the Go together groups, so their matched
    // chats are dissolved (by the listener on `EVENT_DELETING`) before the row
    // goes, and a failure there keeps the gathering.
    it('winds down matched chats before the row is deleted', async () => {
      events.findOne.mockResolvedValue(cancelledEvent);
      await service.remove('party', 'host');
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(EVENT_DELETING, {
        eventId: 'e1',
      });
      expect(eventEmitter.emitAsync.mock.invocationCallOrder[0]).toBeLessThan(
        events.delete.mock.invocationCallOrder[0]!,
      );
    });

    it('waits for the wind-down to finish before deleting', async () => {
      events.findOne.mockResolvedValue(cancelledEvent);
      let hasWoundDown = false;
      eventEmitter.emitAsync.mockImplementation(async () => {
        await Promise.resolve();
        hasWoundDown = true;
        return [];
      });
      events.delete.mockImplementation(async () => {
        expect(hasWoundDown).toBe(true);
        return { affected: 1 };
      });
      await expect(service.remove('party', 'host')).resolves.toEqual({
        ok: true,
      });
      expect(events.delete).toHaveBeenCalledTimes(1);
    });

    it('keeps the gathering with a 503 when a matched chat could not be dissolved', async () => {
      events.findOne.mockResolvedValue(cancelledEvent);
      eventEmitter.emitAsync.mockRejectedValue(
        new Error('chat service is down'),
      );
      await expect(service.remove('party', 'host')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(events.delete).not.toHaveBeenCalled();
    });

    it('announces nothing when the stake check refuses the delete', async () => {
      events.findOne.mockResolvedValue(publishedEvent);
      rsvps.count.mockResolvedValue(1);
      await expect(service.remove('party', 'host')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
    });
  });

  // A family decides WHICH of the six detail keys a gathering may carry, and
  // the service is the only place that enforces it: the DTO validates the bag
  // for shape alone, so a host who switches family mid-edit gets the stale
  // answer dropped rather than a 400 naming a field the wizard stopped showing.
  describe('gathering family and format details', () => {
    it('strips detail keys the created family does not allow', async () => {
      const detail = await service.create('host-1', {
        title: 'Sunday screening',
        description: 'One film, a wall, a projector.',
        startAt: '2099-01-01T18:00:00.000Z',
        timezone: 'Europe/Lisbon',
        gatheringFamily: GatheringFamily.Watch,
        eventType: 'screening',
        formatDetails: { runtimeMinutes: 96, bring: 'a blanket' },
      });
      const created = events.create.mock.calls[0]![0];
      expect(created.gatheringFamily).toBe(GatheringFamily.Watch);
      expect(created.formatDetails).toEqual({ runtimeMinutes: 96 });
      // And both reach the reader, so the detail page can gate its modules.
      expect(detail.gatheringFamily).toBe(GatheringFamily.Watch);
      expect(detail.formatDetails).toEqual({ runtimeMinutes: 96 });
    });

    it('stores null when nothing in the bag survives the strip', async () => {
      await service.create('host-1', {
        title: 'Monday meeting',
        description: 'An agenda and decisions.',
        startAt: '2099-01-01T18:00:00.000Z',
        timezone: 'Europe/Lisbon',
        gatheringFamily: GatheringFamily.Organise,
        eventType: 'meeting',
        formatDetails: { bring: 'a pen' },
      });
      const created = events.create.mock.calls[0]![0];
      expect(created.formatDetails).toBeNull();
    });

    it('re-strips the stored bag against a newly patched family', async () => {
      events.findOne.mockResolvedValue({
        ...editableEvent(),
        gatheringFamily: GatheringFamily.Eat,
        formatDetails: { bring: 'a dish' },
      });

      const detail = await service.update('x', 'u1', {
        gatheringFamily: GatheringFamily.Watch,
      });

      expect(detail.gatheringFamily).toBe(GatheringFamily.Watch);
      expect(detail.formatDetails).toBeNull();
    });

    it('leaves the stored bag alone when the patch touches neither half', async () => {
      events.findOne.mockResolvedValue({
        ...editableEvent(),
        gatheringFamily: GatheringFamily.Eat,
        formatDetails: { bring: 'a dish' },
      });

      const detail = await service.update('x', 'u1', { title: 'New title' });

      expect(detail.formatDetails).toEqual({ bring: 'a dish' });
    });

    it('narrows the browse query by family', async () => {
      const { queryBuilder, recordedWhereCalls } = recordingListQueryBuilder();
      events.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.list('viewer-1', 'upcoming', 1, {
        family: GatheringFamily.Party,
      });

      expect(recordedWhereCalls).toContainEqual({
        clause: 'e.gathering_family = :discoveryFamily',
        parameters: { discoveryFamily: GatheringFamily.Party },
      });
    });

    it('leaves the browse query unnarrowed when no family is asked for', async () => {
      const { queryBuilder, recordedWhereCalls } = recordingListQueryBuilder();
      events.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.list('viewer-1', 'upcoming', 1, {});

      expect(
        recordedWhereCalls.some((call) =>
          call.clause.includes(':discoveryFamily'),
        ),
      ).toBe(false);
    });
  });

  // The care layer the v2 wizard adds (themes, content notes, house rules,
  // cost kind, RSVP cutoff and questions). Written onto every occurrence of a
  // series; on update the arrays replace wholesale and the questions merge
  // per key; a free gathering stores no price.
  describe('gathering care fields', () => {
    const baseCreate = {
      title: 'Thursday supper',
      description: 'A long table and one pot.',
      startAt: '2099-01-01T18:00:00.000Z',
      timezone: 'Europe/Lisbon',
    };

    it('writes every care field on create and carries them on the detail', async () => {
      const detail = await service.create('host-1', {
        ...baseCreate,
        themes: ['trans-led', 'sober'],
        contentNotes: ['loud-sound'],
        houseRules: '  Ask before photos.  ',
        costKind: 'pay-what-you-can',
        cost: '5 to 15 EUR',
        rsvpCutoff: 'day-before',
        rsvpQuestions: { pronouns: true },
        customRsvpQuestion: '  What should we cook?  ',
      });

      const created = events.create.mock.calls[0]![0];
      expect(created.themes).toEqual(['trans-led', 'sober']);
      expect(created.contentNotes).toEqual(['loud-sound']);
      expect(created.houseRules).toBe('Ask before photos.');
      expect(created.costKind).toBe('pay-what-you-can');
      expect(created.cost).toBe('5 to 15 EUR');
      expect(created.rsvpCutoff).toBe('day-before');
      expect(created.rsvpQuestions).toEqual({
        dietary: false,
        pronouns: true,
        access: false,
      });
      expect(created.customRsvpQuestion).toBe('What should we cook?');

      expect(detail.themes).toEqual(['trans-led', 'sober']);
      expect(detail.costKind).toBe('pay-what-you-can');
      expect(detail.contentNotes).toEqual(['loud-sound']);
      expect(detail.houseRules).toBe('Ask before photos.');
      expect(detail.rsvpCutoff).toBe('day-before');
      // 24 hours before the start, as an ISO instant.
      expect(detail.rsvpClosesAt).toBe('2098-12-31T18:00:00.000Z');
      expect(detail.rsvpQuestions).toEqual({
        dietary: false,
        pronouns: true,
        access: false,
      });
      expect(detail.customRsvpQuestion).toBe('What should we cook?');
    });

    it('hosts a public gathering with a community only through the owner-or-mod check', async () => {
      membership.assertOwnerOrModBySlug.mockResolvedValue('community-9');
      await service.create('host-1', {
        ...baseCreate,
        communitySlug: 'queer-devs',
      });
      expect(membership.assertOwnerOrModBySlug).toHaveBeenCalledWith(
        'queer-devs',
        'host-1',
      );
      const created = events.create.mock.calls[0]![0];
      expect(created.communityId).toBe('community-9');
      expect(created.visibility).toBe(EventVisibility.Public);
    });

    it('refuses a host who cannot speak for the community', async () => {
      membership.assertOwnerOrModBySlug.mockRejectedValue(
        new ForbiddenException(),
      );
      await expect(
        service.create('host-1', {
          ...baseCreate,
          communitySlug: 'queer-devs',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(events.create).not.toHaveBeenCalled();
    });

    it('stores empty care fields when the wizard sends none', async () => {
      const detail = await service.create('host-1', baseCreate);

      const created = events.create.mock.calls[0]![0];
      expect(created.themes).toEqual([]);
      expect(created.contentNotes).toEqual([]);
      expect(created.houseRules).toBeNull();
      expect(created.costKind).toBeNull();
      expect(created.rsvpCutoff).toBeNull();
      expect(created.rsvpQuestions).toEqual({
        dietary: false,
        pronouns: false,
        access: false,
      });
      expect(created.customRsvpQuestion).toBeNull();
      expect(detail.rsvpClosesAt).toBeNull();
    });

    it('drops the price of a free gathering on create', async () => {
      await service.create('host-1', {
        ...baseCreate,
        costKind: 'free',
        cost: '10 EUR',
      });
      const created = events.create.mock.calls[0]![0];
      expect(created.costKind).toBe('free');
      expect(created.cost).toBeNull();
    });

    it('stores blank house rules and a blank custom question as null', async () => {
      await service.create('host-1', {
        ...baseCreate,
        houseRules: '   ',
        customRsvpQuestion: '',
      });
      const created = events.create.mock.calls[0]![0];
      expect(created.houseRules).toBeNull();
      expect(created.customRsvpQuestion).toBeNull();
    });

    it('writes the care fields onto every occurrence of a series', async () => {
      await service.create('host-1', {
        ...baseCreate,
        themes: ['newcomers-to-lisbon'],
        contentNotes: ['alcohol-present'],
        houseRules: 'Leave the table as you found it.',
        costKind: 'fixed',
        cost: '8 EUR',
        rsvpCutoff: 'three-days-before',
        rsvpQuestions: { dietary: true },
        customRsvpQuestion: 'Any allergies we missed?',
        recurrence: { cadence: 'weekly', endType: 'count', endCount: 3 },
      });

      expect(events.create).toHaveBeenCalledTimes(3);
      for (const [createdOccurrence] of events.create.mock.calls) {
        expect(createdOccurrence).toEqual(
          expect.objectContaining({
            themes: ['newcomers-to-lisbon'],
            contentNotes: ['alcohol-present'],
            houseRules: 'Leave the table as you found it.',
            costKind: 'fixed',
            cost: '8 EUR',
            rsvpCutoff: 'three-days-before',
            rsvpQuestions: { dietary: true, pronouns: false, access: false },
            customRsvpQuestion: 'Any allergies we missed?',
          }),
        );
      }
      // Each occurrence holds its own arrays, so editing one row in memory
      // stays on that row alone.
      const [firstOccurrence, secondOccurrence] = events.create.mock.calls;
      expect(firstOccurrence![0].themes).not.toBe(secondOccurrence![0].themes);
    });

    it('replaces the arrays wholesale and merges the questions per key on update', async () => {
      events.findOne.mockResolvedValue({
        ...editableEvent(),
        themes: ['sober', 'sapphic'],
        contentNotes: ['loud-sound'],
        rsvpQuestions: { dietary: true, pronouns: false, access: true },
      });

      const detail = await service.update('x', 'u1', {
        themes: ['trans-led'],
        rsvpQuestions: { pronouns: true, access: false },
      });

      expect(detail.themes).toEqual(['trans-led']);
      // Untouched by the patch, so left as stored.
      expect(detail.contentNotes).toEqual(['loud-sound']);
      expect(detail.rsvpQuestions).toEqual({
        dietary: true,
        pronouns: true,
        access: false,
      });
    });

    it('clears the arrays and nullable strings when the patch sends null', async () => {
      events.findOne.mockResolvedValue({
        ...editableEvent(),
        themes: ['sober'],
        contentNotes: ['violence'],
        houseRules: 'No phones.',
        rsvpCutoff: 'day-before',
        customRsvpQuestion: 'Coming by bike?',
      });

      const detail = await service.update('x', 'u1', {
        themes: null,
        contentNotes: null,
        houseRules: null,
        rsvpCutoff: null,
        customRsvpQuestion: '',
      });

      expect(detail.themes).toEqual([]);
      expect(detail.contentNotes).toEqual([]);
      expect(detail.houseRules).toBeNull();
      expect(detail.rsvpCutoff).toBeNull();
      expect(detail.rsvpClosesAt).toBeNull();
      expect(detail.customRsvpQuestion).toBeNull();
    });

    it('nulls the stored price when a patch marks the gathering free', async () => {
      events.findOne.mockResolvedValue({
        ...editableEvent(),
        cost: '10 EUR',
        costKind: 'fixed',
      });

      const detail = await service.update('x', 'u1', { costKind: 'free' });

      expect(detail.costKind).toBe('free');
      expect(detail.cost).toBeNull();
    });

    it('refuses to store a price on a gathering already marked free', async () => {
      events.findOne.mockResolvedValue({
        ...editableEvent(),
        costKind: 'free',
      });

      const detail = await service.update('x', 'u1', { cost: '10 EUR' });

      expect(detail.cost).toBeNull();
    });

    it('sheds an old price from a free gathering on a patch about something else', async () => {
      events.findOne.mockResolvedValue({
        ...editableEvent(),
        costKind: 'free',
        cost: '10 EUR',
      });

      const detail = await service.update('x', 'u1', {
        title: 'Thursday supper, one street over',
      });

      expect(detail.cost).toBeNull();
      expect(events.save).toHaveBeenCalledWith(
        expect.objectContaining({ costKind: 'free', cost: null }),
      );
    });
  });

  // A series steps on the gathering's own wall clock and hands back every
  // slug it saved. Dated 2099 so the fixture stays in the future for
  // `rejectPast`; Lisbon's October change falls on Sunday 25 October that
  // year too, exactly as in 2026.
  describe('series occurrences', () => {
    const baseSeries = {
      title: 'Thursday supper',
      description: 'A long table and one pot.',
      timezone: 'Europe/Lisbon',
      startAt: '2099-10-18T18:00:00.000Z',
      endAt: '2099-10-18T20:00:00.000Z',
    };

    it('keeps 19:00 Lisbon time across the October change and the elapsed duration', async () => {
      await service.create('host-1', {
        ...baseSeries,
        recurrence: { cadence: 'weekly', endType: 'count', endCount: 3 },
      });

      const schedules = events.create.mock.calls.map(([occurrence]) => [
        occurrence.startAt?.toISOString(),
        occurrence.endAt?.toISOString(),
      ]);
      expect(schedules).toEqual([
        ['2099-10-18T18:00:00.000Z', '2099-10-18T20:00:00.000Z'],
        ['2099-10-25T19:00:00.000Z', '2099-10-25T21:00:00.000Z'],
        ['2099-11-01T19:00:00.000Z', '2099-11-01T21:00:00.000Z'],
      ]);
    });

    // Stepping the instant by elapsed days would put the third date at 18:00
    // UTC, inside this bound. On the local clock it starts at 19:00 UTC, after
    // the instant the host picked, so the series stops at two.
    it('compares endUntil as an instant against the stepped starts', async () => {
      await service.create('host-1', {
        ...baseSeries,
        recurrence: {
          cadence: 'weekly',
          endType: 'date',
          endUntil: '2099-11-01T18:30:00.000Z',
        },
      });

      expect(events.create).toHaveBeenCalledTimes(2);
    });

    it('returns every saved occurrence slug in series order', async () => {
      // Each save claims its slug, so the 2nd and 3rd occurrence of the same
      // title get the random suffix a real database would force on them.
      const takenSlugs = new Set<string>();
      events.exists.mockImplementation(
        (findOptions?: { where?: { slug?: string } }) =>
          Promise.resolve(takenSlugs.has(findOptions?.where?.slug ?? '')),
      );
      events.save.mockImplementation((event: Event) => {
        takenSlugs.add(event.slug);
        return event;
      });

      const detail = await service.create('host-1', {
        ...baseSeries,
        recurrence: { cadence: 'weekly', endType: 'count', endCount: 3 },
      });

      const createdSlugs = events.create.mock.calls.map(
        ([occurrence]) => occurrence.slug,
      );
      expect(detail.occurrenceSlugs).toEqual(createdSlugs);
      expect(detail.occurrenceSlugs).toHaveLength(3);
      expect(new Set(detail.occurrenceSlugs).size).toBe(3);
      expect(detail.occurrenceSlugs[0]).toBe('thursday-supper');
      expect(detail.slug).toBe('thursday-supper');
    });

    it('returns the one slug of a single gathering', async () => {
      const detail = await service.create('host-1', baseSeries);

      expect(detail.occurrenceSlugs).toEqual([detail.slug]);
    });
  });

  // `filter=hosting` honours `to` alone, as an upper bound on the start: the
  // wizard's "same as last time" asks for `to=now`. Both arms of the OR carry
  // the bound, or every future co-hosted date would come back onto the page.
  describe('hosting list upper bound', () => {
    const to = '2026-09-11T12:00:00.000Z';

    const hostingWhereFor = async (options: {
      from?: string;
      to?: string;
    }): Promise<unknown> => {
      await service.list('host-1', 'hosting', 1, options);
      const [findOptions] = events.find.mock.calls[0] as [{ where: unknown }];
      return findOptions.where;
    };

    beforeEach(() => {
      cohosts.find.mockResolvedValue([{ eventId: 'cohosted-1' }]);
    });

    it('bounds the start on both the hosted and the co-hosted arm', async () => {
      await expect(hostingWhereFor({ to })).resolves.toEqual([
        { hostId: 'host-1', startAt: LessThanOrEqual(new Date(to)) },
        { id: In(['cohosted-1']), startAt: LessThanOrEqual(new Date(to)) },
      ]);
    });

    it('leaves the list unbounded without `to`, whatever `from` says', async () => {
      await expect(hostingWhereFor({ from: to })).resolves.toEqual([
        { hostId: 'host-1' },
        { id: In(['cohosted-1']) },
      ]);
    });

    it('ignores an unparseable `to`', async () => {
      await expect(hostingWhereFor({ to: 'not a date' })).resolves.toEqual([
        { hostId: 'host-1' },
        { id: In(['cohosted-1']) },
      ]);
    });
  });
});

describe('EventsService.addCohostByUserId', () => {
  let service: EventsService;
  let events: { findOne: jest.Mock };
  let cohosts: { createQueryBuilder: jest.Mock };
  let insertBuilder: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orIgnore: jest.Mock;
    execute: jest.Mock;
  };

  beforeEach(() => {
    insertBuilder = {
      insert: jest.fn(),
      into: jest.fn(),
      values: jest.fn(),
      orIgnore: jest.fn(),
      execute: jest.fn(),
    };
    insertBuilder.insert.mockReturnValue(insertBuilder);
    insertBuilder.into.mockReturnValue(insertBuilder);
    insertBuilder.values.mockReturnValue(insertBuilder);
    insertBuilder.orIgnore.mockReturnValue(insertBuilder);
    insertBuilder.execute.mockResolvedValue({});

    events = { findOne: jest.fn() };
    cohosts = { createQueryBuilder: jest.fn(() => insertBuilder) };

    service = new EventsService(
      // `rosterCounts` reads `retention.eventAttendanceDays` through this to
      // decide whether a gathering's check-in count is still knowable. These
      // tests never reach it, so the default is enough.
      {
        get: (_key: string, fallback?: number) => fallback,
      } as unknown as ConfigService,
      events as unknown as Repository<Event>,
      cohosts as unknown as Repository<EventCohost>,
      {} as unknown as Repository<EventRsvp>,
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
      {} as unknown as EventEmitter2,
    );
  });

  it('throws NotFoundException when the event does not exist', async () => {
    events.findOne.mockResolvedValue(null);
    await expect(
      service.addCohostByUserId('missing-event', 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is a no-op when the user is already the host', async () => {
    events.findOne.mockResolvedValue({ id: 'e1', hostId: 'host-1' });
    await service.addCohostByUserId('e1', 'host-1');
    expect(cohosts.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('inserts an idempotent cohost row for a non-host user', async () => {
    events.findOne.mockResolvedValue({ id: 'e1', hostId: 'host-1' });
    await service.addCohostByUserId('e1', 'user-2');
    expect(insertBuilder.values).toHaveBeenCalledWith({
      eventId: 'e1',
      userId: 'user-2',
    });
    expect(insertBuilder.orIgnore).toHaveBeenCalled();
  });
});

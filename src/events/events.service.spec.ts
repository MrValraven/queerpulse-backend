import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
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
import { Event, EventStatus, EventVisibility } from './entities/event.entity';
import { EventsService } from './events.service';
import { RsvpService } from './rsvp.service';

describe('EventsService', () => {
  let service: EventsService;
  let events: {
    findOne: jest.Mock;
    save: jest.Mock<Event, [Event]>;
    exists: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
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
    assertMemberBySlug: jest.Mock;
    isMember: jest.Mock;
    communityIdsForUser: jest.Mock;
    slugById: jest.Mock;
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

  // A chainable query-builder stub for the RSVP queries: `attendees`'
  // paginated page (`.skip().take().getManyAndCount()`, matching
  // `common/pagination.ts`'s `paginate()`) and the detail's
  // `goingAttendeesPreview`, which counts first and then takes a capped slice
  // (`.getCount()` then `.take().getMany()`).
  const attendeesQbStub = () => {
    const qb: Record<string, jest.Mock> = {};
    for (const m of [
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
    ]) {
      qb[m] = jest.fn().mockReturnValue(qb);
    }
    qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
    qb.getCount = jest.fn().mockResolvedValue(0);
    qb.getMany = jest.fn().mockResolvedValue([]);
    return qb;
  };

  beforeEach(async () => {
    events = {
      findOne: jest.fn(),
      save: jest.fn((event: Event) => event),
      exists: jest.fn().mockResolvedValue(false),
      // Series scope (`update`/`cancel` with `scope: 'future'`) resolves the
      // later occurrences with `find`; no test here exercises a series, so the
      // default is "this event has no siblings".
      find: jest.fn().mockResolvedValue([]),
      // `cancel` flips every occurrence in ONE statement rather than saving
      // them one at a time.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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
      assertMemberBySlug: jest.fn().mockResolvedValue('community-1'),
      isMember: jest.fn().mockResolvedValue(false),
      communityIdsForUser: jest.fn().mockResolvedValue([]),
      slugById: jest.fn().mockResolvedValue(null),
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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventCohost), useValue: cohosts },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvps },
        { provide: getRepositoryToken(EventInvite), useValue: invites },
        {
          provide: getRepositoryToken(EventLineupEntry),
          useValue: lineupEntries,
        },
        { provide: getRepositoryToken(EventSeries), useValue: eventSeries },
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
      visibility: EventVisibility.Public,
      capacity: 20,
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
      visibility: EventVisibility.Public,
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
      visibility: EventVisibility.Public,
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
      visibility: EventVisibility.InviteOnly,
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
      visibility: EventVisibility.InviteOnly,
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
  // authorization check (`assertMemberBySlug`), applied to the acting
  // organizer (`userId`) rather than always `hostId`.
  describe('update communitySlug handling', () => {
    const baseEvent = () => ({
      id: 'e1',
      slug: 'x',
      hostId: 'u1',
      status: EventStatus.Published,
      visibility: EventVisibility.Public,
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
      capacity: null,
      communityId: null,
    });

    it('resolves a non-empty communitySlug via the SAME authorization create() uses', async () => {
      events.findOne.mockResolvedValue(baseEvent());
      membership.assertMemberBySlug.mockResolvedValue('community-9');
      const detail = await service.update('x', 'u1', {
        communitySlug: 'queer-devs',
      });
      expect(membership.assertMemberBySlug).toHaveBeenCalledWith(
        'queer-devs',
        'u1',
      );
      expect(detail.communityId).toBe('community-9');
    });

    it('detaches the community when communitySlug is explicitly null', async () => {
      events.findOne.mockResolvedValue({
        ...baseEvent(),
        communityId: 'community-9',
      });
      const detail = await service.update('x', 'u1', { communitySlug: null });
      expect(membership.assertMemberBySlug).not.toHaveBeenCalled();
      expect(detail.communityId).toBeNull();
    });

    it('detaches the community when communitySlug is an empty string', async () => {
      events.findOne.mockResolvedValue({
        ...baseEvent(),
        communityId: 'community-9',
      });
      const detail = await service.update('x', 'u1', { communitySlug: '' });
      expect(detail.communityId).toBeNull();
    });

    it('leaves communityId unchanged when communitySlug is absent from the patch', async () => {
      events.findOne.mockResolvedValue({
        ...baseEvent(),
        communityId: 'community-9',
      });
      const detail = await service.update('x', 'u1', { capacity: 3 });
      expect(membership.assertMemberBySlug).not.toHaveBeenCalled();
      expect(detail.communityId).toBe('community-9');
    });

    it('400s when detaching the community while visibility stays community', async () => {
      events.findOne.mockResolvedValue({
        ...baseEvent(),
        visibility: EventVisibility.Community,
        communityId: 'community-9',
      });
      await expect(
        service.update('x', 'u1', { communitySlug: null }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400s when switching visibility to community with no resolved community', async () => {
      events.findOne.mockResolvedValue(baseEvent()); // communityId: null
      await expect(
        service.update('x', 'u1', { visibility: EventVisibility.Community }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('cancel notifies going/maybe/waitlisted RSVPs, excluding the organizer', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'party',
      hostId: 'host',
      status: EventStatus.Published,
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

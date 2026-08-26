import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
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
import { EventAnnouncement } from './entities/event-announcement.entity';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventLineupEntry } from './entities/event-lineup-entry.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { EventSeries } from './entities/event-series.entity';
import {
  Event,
  EventStatus,
  EventVenueConfirmation,
  EventVisibility,
} from './entities/event.entity';
import { EventsService } from './events.service';
import { RsvpService } from './rsvp.service';

/**
 * LOC-16, the EVENTS half: attaching a gathering to a directory listing is an
 * ASK, not a fait accompli.
 *
 * What this file pins down:
 *  - a brand-new attachment is `pending`, never `confirmed`;
 *  - the venue's owner is asked exactly once, and only when the gathering can
 *    actually reach that venue's public page (published, `public`/`members`);
 *  - a draft or a `network`-scoped gathering raises no ask at all, because
 *    naming a private gathering to somebody outside its audience would be a
 *    disclosure this feature has no right to make;
 *  - an owner's detach sticks: the host cannot re-attach the same venue.
 */
describe('EventsService venue confirmation (LOC-16)', () => {
  let service: EventsService;
  let events: {
    create: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    exists: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let notifications: { create: jest.Mock; createForRecipients: jest.Mock };
  let listingLookup: {
    findLive: jest.Mock;
    findLinkable: jest.Mock;
    findAttachable: jest.Mock;
  };

  const LUX = {
    id: 'listing-lux',
    slug: 'lux-cafe',
    name: 'Lux Cafe',
    ownerId: 'owner-1',
  };

  const baseCreateInput = {
    title: 'Open mic',
    description: 'Come and read.',
    startAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    timezone: 'Europe/Lisbon',
  };

  /** The single row `create()` handed to `save`. */
  const savedRow = (): Event => {
    const [row] = events.save.mock.calls[0] as [Event];
    return row;
  };

  // `NotificationsService.create(userId, type, payload, actorId?)`. Typing the
  // call tuple here rather than indexing an `any` at each assertion is what
  // keeps every reader below type-safe.
  type CreateCall = [
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
    actorId?: string,
  ];
  /** The single ask, asserted to exist so each case reads a defined tuple. */
  const onlyAttachmentAsk = (): CreateCall => {
    const [ask] = attachmentAsks();
    if (!ask) throw new Error('expected exactly one venue-attachment ask');
    return ask;
  };
  const attachmentAsks = (): CreateCall[] =>
    (notifications.create.mock.calls as CreateCall[]).filter(
      (call) => call[1] === NotificationType.VenueEventAttachment,
    );

  const qbStub = () => {
    const qb: Record<string, jest.Mock> = {};
    for (const method of [
      'where',
      'andWhere',
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
    return qb;
  };

  beforeEach(async () => {
    events = {
      create: jest.fn((entityLike: Partial<Event>) => ({ ...entityLike })),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((event: Event) =>
        Promise.resolve({ ...event, id: event.id ?? 'event-1' }),
      ),
      exists: jest.fn().mockResolvedValue(false),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(0),
      manager: {
        transaction: jest.fn(
          async (runInTransaction: (manager: unknown) => Promise<unknown>) =>
            runInTransaction({
              save: (_entity: unknown, entityLike: Event): Promise<Event> =>
                events.save(entityLike) as Promise<Event>,
              getRepository: () => events,
            }),
        ),
      },
    };
    notifications = {
      create: jest.fn().mockResolvedValue(null),
      createForRecipients: jest.fn().mockResolvedValue([]),
    };
    listingLookup = {
      findLive: jest.fn().mockResolvedValue(null),
      findLinkable: jest.fn().mockResolvedValue(null),
      findAttachable: jest.fn().mockResolvedValue(LUX),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: getRepositoryToken(Event), useValue: events },
        {
          provide: getRepositoryToken(EventCohost),
          useValue: {
            exists: jest.fn().mockResolvedValue(false),
            find: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: getRepositoryToken(EventRsvp),
          useValue: {
            count: jest.fn().mockResolvedValue(0),
            findOne: jest.fn().mockResolvedValue(null),
            exists: jest.fn().mockResolvedValue(false),
            find: jest.fn().mockResolvedValue([]),
            createQueryBuilder: jest.fn(() => qbStub()),
          },
        },
        {
          provide: getRepositoryToken(EventInvite),
          useValue: {
            exists: jest.fn().mockResolvedValue(false),
            find: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: getRepositoryToken(EventLineupEntry),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(EventSeries),
          useValue: {
            create: jest.fn((entity: unknown) => entity),
            save: jest.fn((entity: object) =>
              Promise.resolve({ id: 'series-1', ...entity }),
            ),
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: getRepositoryToken(EventAnnouncement),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(Profile),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: UsersService, useValue: { findById: jest.fn() } },
        {
          provide: RsvpService,
          useValue: {
            reconcileWaitlist: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: BlockFilterService,
          useValue: { excludeBlocked: jest.fn((qb: unknown) => qb) },
        },
        {
          provide: ContentModerationService,
          useValue: {
            stateFor: jest
              .fn()
              .mockResolvedValue({ hidden: false, removed: false }),
          },
        },
        {
          provide: CommunityMembershipService,
          useValue: {
            assertMemberBySlug: jest.fn().mockResolvedValue('community-1'),
            isMember: jest.fn().mockResolvedValue(false),
            communityIdsForUser: jest.fn().mockResolvedValue([]),
            slugById: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: EventBookmarksService,
          useValue: {
            isBookmarked: jest.fn().mockResolvedValue(false),
            bookmarkedEventIds: jest.fn().mockResolvedValue(new Set<string>()),
            listSaved: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: EventAudienceGateService,
          useValue: {
            assertViewable: jest.fn().mockResolvedValue(undefined),
            scopedVisibilityWhere: jest.fn().mockResolvedValue({
              clause: 'e.visibility IN (:...vis)',
              params: {
                vis: [EventVisibility.Public, EventVisibility.Members],
              },
            }),
          },
        },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        { provide: ListingLookupService, useValue: listingLookup },
      ],
    }).compile();
    service = module.get(EventsService);
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
    jest.clearAllMocks();
  });

  describe('a new attachment starts pending', () => {
    it('writes venue_confirmation = pending, never confirmed', async () => {
      await service.create('host-1', {
        ...baseCreateInput,
        listingId: LUX.id,
      });

      expect(savedRow().listingId).toBe(LUX.id);
      expect(savedRow().venueConfirmation).toBe(EventVenueConfirmation.Pending);
      expect(savedRow().venueConfirmedAt ?? null).toBeNull();
    });

    it('asks the venue owner once, naming the venue and the gathering', async () => {
      await service.create('host-1', {
        ...baseCreateInput,
        listingId: LUX.id,
      });

      expect(attachmentAsks()).toHaveLength(1);
      const [recipientId, , payload] = onlyAttachmentAsk();
      expect(recipientId).toBe(LUX.ownerId);
      expect(payload).toMatchObject({
        source: 'listing',
        listingSlug: LUX.slug,
        listingName: LUX.name,
        eventTitle: 'Open mic',
      });
    });

    it('passes NO actor, so a block cannot suppress the owner’s only warning', async () => {
      await service.create('host-1', {
        ...baseCreateInput,
        listingId: LUX.id,
      });

      // `NotificationsService.create(userId, type, payload, actorId?)`: the
      // fourth argument runs the block/mute filter, and a host the owner has
      // blocked must not be able to attach silently.
      expect(onlyAttachmentAsk()[3]).toBeUndefined();
      expect(onlyAttachmentAsk()[2]).not.toHaveProperty('actorId');
    });

    it('raises no ask for a gathering scoped tighter than members', async () => {
      await service.create('host-1', {
        ...baseCreateInput,
        listingId: LUX.id,
        visibility: EventVisibility.Network,
      });

      expect(attachmentAsks()).toHaveLength(0);
      // Not stamped either, so publishing it wider later still asks.
      expect(savedRow().venueOwnerNotifiedAt).toBeNull();
      expect(savedRow().venueConfirmation).toBe(EventVenueConfirmation.Pending);
    });

    it('raises no ask for a draft', async () => {
      await service.create('host-1', {
        ...baseCreateInput,
        listingId: LUX.id,
        status: EventStatus.Draft,
      });

      expect(attachmentAsks()).toHaveLength(0);
      expect(savedRow().venueOwnerNotifiedAt).toBeNull();
    });

    it('raises no ask when the listing has no owner to ask', async () => {
      listingLookup.findAttachable.mockResolvedValue({ ...LUX, ownerId: null });

      await service.create('host-1', {
        ...baseCreateInput,
        listingId: LUX.id,
      });

      expect(attachmentAsks()).toHaveLength(0);
      // Still pending: nobody has agreed, so the anonymous venue page still
      // withholds it.
      expect(savedRow().venueConfirmation).toBe(EventVenueConfirmation.Pending);
    });

    it('refuses a venue that is not a valid link target at all', async () => {
      listingLookup.findAttachable.mockResolvedValue(null);

      await expect(
        service.create('host-1', { ...baseCreateInput, listingId: 'nope' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('an owner’s detach sticks', () => {
    const detachedEvent = (): Event =>
      ({
        id: 'event-1',
        slug: 'open-mic',
        hostId: 'host-1',
        title: 'Open mic',
        description: 'Come and read.',
        startAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        endAt: null,
        timezone: 'Europe/Lisbon',
        venue: 'Lux Cafe',
        listingId: null,
        communityId: null,
        status: EventStatus.Published,
        visibility: EventVisibility.Public,
        accessibilityAnswers: {},
        accessibilityNote: '',
        venueConfirmation: EventVenueConfirmation.Pending,
        venueConfirmedAt: null,
        venueOwnerNotifiedAt: null,
        venueDetachedListingId: LUX.id,
        venueDetachedAt: new Date('2026-08-20T10:00:00.000Z'),
        seriesId: null,
        seriesIndex: null,
      }) as unknown as Event;

    it('refuses to re-attach the exact listing whose owner detached it', async () => {
      events.findOne.mockResolvedValue(detachedEvent());

      await expect(
        service.update('open-mic', 'host-1', { listingId: LUX.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Nothing was written, so the owner's decision stands.
      expect(events.save).not.toHaveBeenCalled();
    });

    it('still lets the host attach a DIFFERENT venue', async () => {
      events.findOne.mockResolvedValue(detachedEvent());
      const other = {
        id: 'listing-other',
        slug: 'casa-t',
        name: 'Casa T',
        ownerId: 'owner-2',
      };
      listingLookup.findAttachable.mockResolvedValue(other);

      await service.update('open-mic', 'host-1', { listingId: other.id });

      const [patched] = events.save.mock.calls[0] as [Event];
      expect(patched.listingId).toBe(other.id);
      // A new venue is a new ask: state and markers reset.
      expect(patched.venueConfirmation).toBe(EventVenueConfirmation.Pending);
      expect(patched.venueConfirmedAt).toBeNull();
      expect(attachmentAsks()).toHaveLength(1);
      expect(onlyAttachmentAsk()[0]).toBe('owner-2');
    });
  });
});

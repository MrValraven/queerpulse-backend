import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
  toImageUrl,
} from '../common/image-url';
import { AccessTier } from '../communities/entities/community.entity';
import { emptyAccessibilityAnswers } from '../listings/listing-accessibility';
import {
  Event,
  EventStatus,
  EventVisibility,
  GatheringFamily,
} from './entities/event.entity';
import { eventBatchTemplateNotFound, templateCreateInput } from './event-batch';
import {
  EventBatchTemplateService,
  toEventBatchTemplateView,
  type ResolvedEventBatchTemplate,
} from './event-batch-template.service';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const COHOST_ID = '22222222-2222-4222-8222-222222222222';
const STRANGER_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';
const COMMUNITY_ID = '55555555-5555-4555-8555-555555555555';
const RUN_BY_ID = '66666666-6666-4666-8666-666666666666';
const VENUE_LISTING_ID = '77777777-7777-4777-8777-777777777777';
const TEMPLATE_SLUG = 'quiz-night';
const TEMPLATE_COVER = `event-covers/${HOST_ID}/88888888-8888-4888-8888-888888888888.webp`;

const RUN_BY_REF = {
  id: RUN_BY_ID,
  ref: 'QPL-2026-0042',
  slug: 'bar-name',
  name: 'Bar Name',
};
const COMMUNITY_REF = {
  slug: 'queer-runners',
  name: 'Queer Runners',
  accessTier: AccessTier.Public,
  avatarImageUrl: null,
};
const VENUE_REF = {
  id: VENUE_LISTING_ID,
  slug: 'bar-a',
  name: 'Bar A',
  ownerId: null,
};

/** The 39 keys of `EventBatchTemplateView`, contract section 4. */
const CONTRACT_VIEW_KEYS = [
  'slug',
  'title',
  'description',
  'timezone',
  'startTime',
  'endTime',
  'coverImageUrl',
  'gatheringFamily',
  'eventType',
  'formatDetails',
  'neighbourhood',
  'venue',
  'listingId',
  'venueListing',
  'isOnline',
  'onlineUrl',
  'address',
  'arrivalNotes',
  'capacity',
  'language',
  'cost',
  'costKind',
  'paymentUrl',
  'paymentInstructions',
  'accessibility',
  'visibility',
  'community',
  'communityDropped',
  'runByListing',
  'runByDropped',
  'venueListingDropped',
  'themes',
  'contentNotes',
  'houseRules',
  'rsvpCutoff',
  'rsvpQuestions',
  'customRsvpQuestion',
  'allowWaitlist',
  'showAttendeeCount',
];

function templateEvent(overrides: Partial<Event> = {}): Event {
  const storedFields: Partial<Event> = {
    id: EVENT_ID,
    slug: TEMPLATE_SLUG,
    title: 'Quiz Night',
    description: 'Teams of four, prizes for the top three',
    status: EventStatus.Published,
    visibility: EventVisibility.Public,
    timezone: 'Europe/Lisbon',
    startAt: new Date('2026-10-24T20:00:00.000Z'),
    endAt: null,
    hostId: HOST_ID,
    communityId: null,
    listingId: null,
    runByListingId: null,
    coverImageUrl: TEMPLATE_COVER,
    gatheringFamily: GatheringFamily.Meet,
    eventType: 'quiz',
    formatDetails: null,
    neighbourhood: 'Intendente',
    venue: 'Bar A, upstairs',
    isOnline: false,
    onlineUrl: null,
    address: 'Rua dos Anjos 1',
    arrivalNotes: 'Ring the bell',
    capacity: 40,
    language: 'en',
    cost: '5 EUR',
    costKind: 'fixed',
    paymentUrl: null,
    paymentInstructions: 'Pay at the door',
    accessibilityAnswers: emptyAccessibilityAnswers(),
    accessibilityNote: 'Two steps at the door',
    themes: ['sapphic'],
    contentNotes: [],
    houseRules: 'Be kind',
    rsvpCutoff: null,
    rsvpQuestions: { dietary: false, pronouns: true, access: false },
    customRsvpQuestion: null,
    allowWaitlist: true,
    showAttendeeCount: true,
  };
  return Object.assign(new Event(), storedFields, overrides);
}

function reasonCodeOf(failure: unknown): unknown {
  const response = (failure as HttpException).getResponse();
  return (response as { code?: unknown }).code;
}

describe('EventBatchTemplateService', () => {
  let events: { findOne: jest.Mock };
  let cohosts: { exists: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };
  let membership: {
    hostingRefById: jest.Mock;
    assertOwnerOrModBySlug: jest.Mock;
  };
  let runByListings: {
    assertCanRunGatherings: jest.Mock;
    displayNameOf: jest.Mock;
  };
  let listingLookup: { findAttachable: jest.Mock };
  let service: EventBatchTemplateService;

  function useTemplate(overrides: Partial<Event> = {}): Event {
    const template = templateEvent(overrides);
    events.findOne.mockResolvedValue(template);
    return template;
  }

  async function failureOf(pending: Promise<unknown>): Promise<unknown> {
    return pending.then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  beforeEach(() => {
    setImageUrlBase('https://api.test');
    events = { findOne: jest.fn().mockResolvedValue(templateEvent()) };
    cohosts = { exists: jest.fn().mockResolvedValue(false) };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    membership = {
      hostingRefById: jest.fn().mockResolvedValue(COMMUNITY_REF),
      assertOwnerOrModBySlug: jest.fn().mockResolvedValue(COMMUNITY_ID),
    };
    runByListings = {
      assertCanRunGatherings: jest.fn().mockResolvedValue(RUN_BY_REF),
      displayNameOf: jest.fn().mockResolvedValue(RUN_BY_REF.name),
    };
    listingLookup = {
      findAttachable: jest.fn().mockResolvedValue(VENUE_REF),
    };
    service = new EventBatchTemplateService(
      events as never,
      cohosts as never,
      contentModeration as never,
      membership as never,
      runByListings as never,
      listingLookup as never,
    );
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('who may start from an event', () => {
    it('admits the host', async () => {
      const resolved = await service.resolveForCaller(TEMPLATE_SLUG, HOST_ID);

      expect(resolved.template.id).toBe(EVENT_ID);
      expect(events.findOne).toHaveBeenCalledWith({
        where: { slug: TEMPLATE_SLUG },
      });
      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'event',
        EVENT_ID,
      );
    });

    it('admits an accepted co-host', async () => {
      cohosts.exists.mockResolvedValue(true);

      const resolved = await service.resolveForCaller(TEMPLATE_SLUG, COHOST_ID);

      expect(resolved.template.id).toBe(EVENT_ID);
      expect(cohosts.exists).toHaveBeenCalledWith({
        where: { eventId: EVENT_ID, userId: COHOST_ID },
      });
    });

    it('admits a draft and a past event', async () => {
      useTemplate({ status: EventStatus.Draft });
      await expect(
        service.resolveForCaller(TEMPLATE_SLUG, HOST_ID),
      ).resolves.toMatchObject({ template: { status: EventStatus.Draft } });

      const pastStart = new Date('2020-01-10T20:00:00.000Z');
      useTemplate({ startAt: pastStart });
      await expect(
        service.resolveForCaller(TEMPLATE_SLUG, HOST_ID),
      ).resolves.toMatchObject({ template: { startAt: pastStart } });
    });

    // Each case arranges its refusal and answers the caller who asks.
    it.each<[string, () => string]>([
      [
        'an unknown slug',
        () => {
          events.findOne.mockResolvedValue(null);
          return HOST_ID;
        },
      ],
      [
        'a cancelled event',
        () => {
          useTemplate({ status: EventStatus.Cancelled });
          return HOST_ID;
        },
      ],
      ['a member outside the hosts', () => STRANGER_ID],
      [
        'a member holding only a pending co-host invite',
        // A pending invite writes no `event_cohosts` row, so the seat read
        // finds nothing for them.
        () => COHOST_ID,
      ],
      [
        'an event a moderator hid',
        () => {
          contentModeration.stateFor.mockResolvedValue({
            hidden: true,
            removed: false,
          });
          return HOST_ID;
        },
      ],
      [
        'an event a moderator removed',
        () => {
          contentModeration.stateFor.mockResolvedValue({
            hidden: false,
            removed: true,
          });
          return HOST_ID;
        },
      ],
    ])(
      'answers EVENT_BATCH_TEMPLATE_NOT_FOUND for %s',
      async (_case, arrange) => {
        const callerId = arrange();

        const failure = await failureOf(
          service.resolveForCaller(TEMPLATE_SLUG, callerId),
        );

        expect(failure).toBeInstanceOf(NotFoundException);
        expect((failure as NotFoundException).getResponse()).toEqual(
          eventBatchTemplateNotFound().getResponse(),
        );
      },
    );
  });

  describe('run by', () => {
    beforeEach(() => {
      useTemplate({ runByListingId: RUN_BY_ID });
      cohosts.exists.mockResolvedValue(true);
    });

    it('keeps run by when the caller runs the business', async () => {
      const resolved = await service.resolveForCaller(TEMPLATE_SLUG, COHOST_ID);

      expect(runByListings.assertCanRunGatherings).toHaveBeenCalledTimes(1);
      expect(runByListings.assertCanRunGatherings).toHaveBeenCalledWith(
        RUN_BY_ID,
        [COHOST_ID],
      );
      expect(resolved.runByListing).toEqual(RUN_BY_REF);
      expect(resolved.runByDropped).toBeNull();
      expect(resolved.templateFields.runByListingId).toBe(RUN_BY_ID);
    });

    it('drops run by for a co-host who does not run the business, and names it', async () => {
      runByListings.assertCanRunGatherings.mockRejectedValue(
        new ForbiddenException({ code: 'RUN_BY_NOT_MANAGER' }),
      );
      runByListings.displayNameOf.mockResolvedValue('Bar Name');

      const resolved = await service.resolveForCaller(TEMPLATE_SLUG, COHOST_ID);

      expect(resolved.runByListing).toBeNull();
      expect(resolved.runByDropped).toEqual({
        name: 'Bar Name',
        reason: 'notManager',
      });
      expect(resolved.templateFields.runByListingId).toBeNull();
      expect(runByListings.displayNameOf).toHaveBeenCalledWith(RUN_BY_ID);
    });

    it('drops run by for a business that left the directory', async () => {
      runByListings.assertCanRunGatherings.mockRejectedValue(
        new BadRequestException('Run by listing not found'),
      );

      const resolved = await service.resolveForCaller(TEMPLATE_SLUG, COHOST_ID);

      expect(resolved.runByListing).toBeNull();
      expect(resolved.runByDropped).toEqual({
        name: 'Bar Name',
        reason: 'unavailable',
      });
      expect(resolved.templateFields.runByListingId).toBeNull();
    });

    it('rethrows anything other than a refusal', async () => {
      runByListings.assertCanRunGatherings.mockRejectedValue(
        new Error('database down'),
      );

      await expect(
        service.resolveForCaller(TEMPLATE_SLUG, COHOST_ID),
      ).rejects.toThrow('database down');
      expect(runByListings.displayNameOf).not.toHaveBeenCalled();
    });

    it('reads nothing for a template without run by', async () => {
      useTemplate({ runByListingId: null });

      const resolved = await service.resolveForCaller(TEMPLATE_SLUG, COHOST_ID);

      expect(runByListings.assertCanRunGatherings).not.toHaveBeenCalled();
      expect(runByListings.displayNameOf).not.toHaveBeenCalled();
      expect(resolved.runByListing).toBeNull();
      expect(resolved.runByDropped).toBeNull();
    });
  });

  describe('community', () => {
    beforeEach(() => {
      useTemplate({ communityId: COMMUNITY_ID });
    });

    it('keeps the community for a moderator', async () => {
      const resolved = await service.resolveForCaller(TEMPLATE_SLUG, HOST_ID);

      expect(membership.hostingRefById).toHaveBeenCalledWith(COMMUNITY_ID);
      expect(membership.assertOwnerOrModBySlug).toHaveBeenCalledWith(
        COMMUNITY_REF.slug,
        HOST_ID,
      );
      expect(resolved.community).toEqual({
        id: COMMUNITY_ID,
        slug: COMMUNITY_REF.slug,
        name: COMMUNITY_REF.name,
      });
      expect(resolved.communityDropped).toBeNull();
      expect(resolved.templateFields.communitySlug).toBe(COMMUNITY_REF.slug);
    });

    it('drops it for a plain member with notModerator', async () => {
      membership.assertOwnerOrModBySlug.mockRejectedValue(
        new ForbiddenException(
          'Only the community owner or a moderator can do that',
        ),
      );

      const resolved = await service.resolveForCaller(TEMPLATE_SLUG, HOST_ID);

      expect(resolved.community).toBeNull();
      expect(resolved.communityDropped).toEqual({
        name: 'Queer Runners',
        reason: 'notModerator',
      });
      expect(resolved.templateFields.communitySlug).toBeNull();
    });

    it('drops an archived community with unavailable', async () => {
      membership.assertOwnerOrModBySlug.mockRejectedValue(
        new NotFoundException('Community not found'),
      );

      const resolved = await service.resolveForCaller(TEMPLATE_SLUG, HOST_ID);

      expect(resolved.community).toBeNull();
      expect(resolved.communityDropped).toEqual({
        name: 'Queer Runners',
        reason: 'unavailable',
      });
      expect(resolved.templateFields.communitySlug).toBeNull();
    });

    it('reads a missing community row as no community', async () => {
      membership.hostingRefById.mockResolvedValue(null);

      const resolved = await service.resolveForCaller(TEMPLATE_SLUG, HOST_ID);

      expect(membership.assertOwnerOrModBySlug).not.toHaveBeenCalled();
      expect(resolved.community).toBeNull();
      expect(resolved.communityDropped).toBeNull();
      expect(resolved.templateFields.communitySlug).toBeNull();
    });

    it('refuses a community-only template whose community drops, naming the community', async () => {
      useTemplate({
        communityId: COMMUNITY_ID,
        visibility: EventVisibility.Community,
      });
      membership.assertOwnerOrModBySlug.mockRejectedValue(
        new ForbiddenException(
          'Only the community owner or a moderator can do that',
        ),
      );

      for (const request of [
        () => service.resolveForCaller(TEMPLATE_SLUG, HOST_ID),
        () => service.getTemplateView(TEMPLATE_SLUG, HOST_ID),
      ]) {
        const failure = await failureOf(request());

        expect(failure).toBeInstanceOf(ConflictException);
        expect(reasonCodeOf(failure)).toBe(
          'EVENT_BATCH_TEMPLATE_COMMUNITY_ONLY',
        );
        expect((failure as ConflictException).getResponse()).toMatchObject({
          statusCode: 409,
          communityName: 'Queer Runners',
        });
      }
    });

    it('refuses a community-only template whose community row is gone, with no name', async () => {
      useTemplate({
        communityId: COMMUNITY_ID,
        visibility: EventVisibility.Community,
      });
      membership.hostingRefById.mockResolvedValue(null);

      const failure = await failureOf(
        service.resolveForCaller(TEMPLATE_SLUG, HOST_ID),
      );

      expect(failure).toBeInstanceOf(ConflictException);
      expect(reasonCodeOf(failure)).toBe('EVENT_BATCH_TEMPLATE_COMMUNITY_ONLY');
      expect((failure as ConflictException).getResponse()).toMatchObject({
        statusCode: 409,
        communityName: null,
        message:
          'The event you started from is only for members of its community, and only its moderators can post events there.',
      });
      expect(membership.assertOwnerOrModBySlug).not.toHaveBeenCalled();
    });
  });

  describe('venue link', () => {
    beforeEach(() => {
      useTemplate({ listingId: VENUE_LISTING_ID });
    });

    it('keeps a venue the directory still lists', async () => {
      const resolved = await service.resolveForCaller(TEMPLATE_SLUG, HOST_ID);

      expect(listingLookup.findAttachable).toHaveBeenCalledWith(
        VENUE_LISTING_ID,
      );
      expect(resolved.venueListing).toEqual(VENUE_REF);
      expect(resolved.venueListingDropped).toBe(false);
      expect(resolved.templateFields.listingId).toBe(VENUE_LISTING_ID);
    });

    it('drops a venue that left the directory and keeps the venue text', async () => {
      listingLookup.findAttachable.mockResolvedValue(null);

      const resolved = await service.resolveForCaller(TEMPLATE_SLUG, HOST_ID);

      expect(resolved.venueListing).toBeNull();
      expect(resolved.venueListingDropped).toBe(true);
      expect(resolved.templateFields.listingId).toBeNull();
      expect(resolved.templateFields.venue).toBe('Bar A, upstairs');
    });
  });

  describe('toEventBatchTemplateView', () => {
    it('reads the template times on its own clock', async () => {
      const view = await service.getTemplateView(TEMPLATE_SLUG, HOST_ID);

      expect(view.startTime).toBe('21:00');
      expect(view.endTime).toBeNull();

      // Lisbon is still on summer time at 00:30 UTC on 2026-10-25; the clock
      // goes back half an hour later.
      useTemplate({ endAt: new Date('2026-10-25T00:30:00.000Z') });
      const viewWithEnd = await service.getTemplateView(TEMPLATE_SLUG, HOST_ID);

      expect(viewWithEnd.startTime).toBe('21:00');
      expect(viewWithEnd.endTime).toBe('01:30');
    });

    it('serves the cover as a display URL', async () => {
      const view = await service.getTemplateView(TEMPLATE_SLUG, HOST_ID);

      expect(view.coverImageUrl).toBe(toImageUrl(TEMPLATE_COVER));
      expect(view.coverImageUrl).toMatch(/^https:\/\/api\.test\//);
    });

    it('carries the drop flags and the kept names', async () => {
      useTemplate({
        communityId: COMMUNITY_ID,
        listingId: VENUE_LISTING_ID,
        runByListingId: RUN_BY_ID,
      });

      const view = await service.getTemplateView(TEMPLATE_SLUG, HOST_ID);

      expect(view.community).toEqual({
        slug: COMMUNITY_REF.slug,
        name: COMMUNITY_REF.name,
      });
      expect(view.runByListing).toEqual({
        ref: RUN_BY_REF.ref,
        slug: RUN_BY_REF.slug,
        name: RUN_BY_REF.name,
      });
      expect(view.venueListing).toEqual({
        slug: VENUE_REF.slug,
        name: VENUE_REF.name,
      });
      expect(view.listingId).toBe(VENUE_LISTING_ID);
      expect(view.communityDropped).toBeNull();
      expect(view.runByDropped).toBeNull();
      expect(view.venueListingDropped).toBe(false);

      const template = templateEvent({
        communityId: COMMUNITY_ID,
        listingId: VENUE_LISTING_ID,
        runByListingId: RUN_BY_ID,
      });
      const droppedEverything: ResolvedEventBatchTemplate = {
        template,
        templateFields: templateCreateInput(template, {
          communitySlug: null,
          listingId: null,
          runByListingId: null,
        }),
        community: null,
        communityDropped: { name: 'Queer Runners', reason: 'notModerator' },
        runByListing: null,
        runByDropped: { name: 'Bar Name', reason: 'notManager' },
        venueListing: null,
        venueListingDropped: true,
      };
      const droppedView = toEventBatchTemplateView(droppedEverything);

      expect(droppedView.community).toBeNull();
      expect(droppedView.communityDropped).toEqual({
        name: 'Queer Runners',
        reason: 'notModerator',
      });
      expect(droppedView.runByListing).toBeNull();
      expect(droppedView.runByDropped).toEqual({
        name: 'Bar Name',
        reason: 'notManager',
      });
      expect(droppedView.venueListing).toBeNull();
      expect(droppedView.listingId).toBeNull();
      expect(droppedView.venueListingDropped).toBe(true);
      expect(droppedView.venue).toBe('Bar A, upstairs');
    });

    it('previews a legacy "Free" as free and clears its amount and payment details', async () => {
      useTemplate({
        costKind: null,
        cost: 'Free',
        paymentUrl: 'https://pay.example/quiz',
        paymentInstructions: 'Pay at the door',
      });

      const view = await service.getTemplateView(TEMPLATE_SLUG, HOST_ID);

      expect(view.costKind).toBe('free');
      expect(view.cost).toBeNull();
      expect(view.paymentUrl).toBeNull();
      expect(view.paymentInstructions).toBeNull();
    });

    it('previews a legacy "10 EUR" as fixed and keeps its payment details', async () => {
      useTemplate({
        costKind: null,
        cost: '10 EUR',
        paymentUrl: 'https://pay.example/quiz',
        paymentInstructions: 'Pay at the door',
      });

      const view = await service.getTemplateView(TEMPLATE_SLUG, HOST_ID);

      expect(view.costKind).toBe('fixed');
      expect(view.cost).toBe('10 EUR');
      expect(view.paymentUrl).toBe('https://pay.example/quiz');
      expect(view.paymentInstructions).toBe('Pay at the door');
    });

    it('has exactly the contract keys', async () => {
      const view = await service.getTemplateView(TEMPLATE_SLUG, HOST_ID);

      expect(CONTRACT_VIEW_KEYS).toHaveLength(39);
      expect(Object.keys(view).sort()).toEqual([...CONTRACT_VIEW_KEYS].sort());
    });
  });
});

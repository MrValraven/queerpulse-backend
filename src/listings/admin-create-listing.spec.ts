import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { MediaCropService } from '../media-crops/media-crops.service';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReportsService } from '../reports/reports.service';
import { SafeSpaceVisitsService } from '../safe-space-vouches/safe-space-visits.service';
import { StorageService } from '../storage/storage.service';
import { ReviewReplyNotifier } from '../submissions/review-reply-notifier.service';
import { Profile } from '../users/entities/profile.entity';
import { AdminCreateListingDto } from './dto/admin-create-listing.dto';
import { CreateListingDto } from './dto/create-listing.dto';
import {
  ListingModerationAction,
  ListingModerationEvent,
} from './entities/listing-moderation-event.entity';
import { ListingPublicQuestion } from './entities/listing-public-question.entity';
import { ListingQuestion } from './entities/listing-question.entity';
import { ListingReview } from './entities/listing-review.entity';
import { Listing, ListingStatus } from './entities/listing.entity';
import { ListingCoManagersService } from './listing-co-managers.service';
import { ListingsService } from './listings.service';

/**
 * ADMIN-AUTHORED LISTINGS: a page the house writes about a business that has
 * never heard of QueerPulse.
 *
 * Three things have to hold for that to be honest, and each has a test here.
 * The row belongs to nobody, so `ownerId` is null and no owner-personal field
 * is invented. The affirming baseline is a promise the business makes, so its
 * stamp stays null until somebody accepts the listing. And the admin's
 * publish choice is recorded as an auditable decision with their name on it.
 *
 * The member submission path shares `createWithUniqueSlug` with this one, so
 * the last case pins its stamps down: a widened helper that quietly changed
 * what a member's submission is worth would be the expensive failure here.
 */

const ADMIN_ID = 'admin-1';

/** A chainable query-builder stub (mirrors `listings.service.spec.ts`). */
const buildQueryBuilderStub = (): Record<string, jest.Mock> => {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of [
    'where',
    'andWhere',
    'leftJoin',
    'orderBy',
    'skip',
    'take',
    'select',
    'addSelect',
    'groupBy',
  ]) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  queryBuilder.getRawMany = jest.fn().mockResolvedValue([]);
  return queryBuilder;
};

/**
 * The smallest admin body, carrying the publish choice.
 *
 * Deliberately says nothing about the owner fields: the DTO omits them, so
 * there is no shape of this fixture that could set one.
 */
const adminDto = (publishState: 'review' | 'live'): AdminCreateListingDto =>
  ({ name: 'Lux Café', publishState }) as AdminCreateListingDto;

describe('ListingsService.adminCreate', () => {
  let service: ListingsService;
  let listings: {
    findOne: jest.Mock;
    find: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let moderationEvents: {
    save: jest.Mock;
    find: jest.Mock;
    findAndCount: jest.Mock;
  };
  let adminQueueNotifications: { announce: jest.Mock };

  /** What `listings.save` was handed, which is the row as it was written. */
  const savedRow = (): Record<string, unknown> => {
    const calls = listings.save.mock.calls as [Record<string, unknown>][];
    const [firstCall] = calls;
    expect(firstCall).toBeDefined();
    return firstCall![0];
  };

  beforeEach(async () => {
    listings = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((value: object) => value),
      // Synthesizes the generated columns, so the mappers reading them off a
      // `save()` result never see `undefined` (the precedent in
      // `listings.service.spec.ts`).
      save: jest.fn((value: object) =>
        Promise.resolve({
          id: 'listing-new',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...value,
        }),
      ),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => buildQueryBuilderStub()),
    };
    moderationEvents = {
      save: jest.fn((value: object) =>
        Promise.resolve({ id: 'event-1', ...value }),
      ),
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        {
          provide: getRepositoryToken(Profile),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: getRepositoryToken(ListingReview),
          useValue: { findOne: jest.fn(), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(ListingModerationEvent),
          useValue: moderationEvents,
        },
        {
          provide: getRepositoryToken(ListingPublicQuestion),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn().mockResolvedValue([]),
            create: jest.fn((value: object) => value),
            save: jest.fn((value: object) => Promise.resolve(value)),
            count: jest.fn().mockResolvedValue(0),
          },
        },
        {
          provide: getRepositoryToken(ListingQuestion),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn().mockResolvedValue([]),
            create: jest.fn((value: object) => value),
            save: jest.fn((value: object) => Promise.resolve(value)),
          },
        },
        {
          provide: DataSource,
          useValue: {
            // `nextRef` reads the listings ref sequence through a raw query.
            query: jest.fn().mockResolvedValue([{ seq: '7' }]),
            transaction: jest.fn(),
          },
        },
        { provide: MessagingService, useValue: { deliverEnquiry: jest.fn() } },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        {
          provide: StorageService,
          useValue: { deleteObjectByReference: jest.fn() },
        },
        { provide: ReportsService, useValue: { create: jest.fn() } },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          provide: ListingCoManagersService,
          useValue: {
            isActiveCoManager: jest.fn().mockResolvedValue(false),
            listingIdsCoManagedBy: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: ReviewReplyNotifier,
          useValue: { notifyReviewReplied: jest.fn() },
        },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
        {
          provide: SafeSpaceVisitsService,
          useValue: { countIndependentVisits: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(ListingsService);
    // The listing mapper resolves photo references through `toImageUrl`,
    // which needs a configured base.
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  it('stamps no owner, no affirming acceptance, and the authoring admin', async () => {
    await service.adminCreate(ADMIN_ID, adminDto('review'));

    expect(savedRow()).toEqual(
      expect.objectContaining({
        ownerId: null,
        affirmingBaselineAcceptedAt: null,
        createdByStaffId: ADMIN_ID,
      }),
    );
  });

  it('defaults the seven owner columns to empty for a body that omits them', async () => {
    await service.adminCreate(ADMIN_ID, adminDto('live'));

    // WHAT THIS PINS, precisely: `normalizeCreate`'s `?? ''` and `?? false`
    // defaults for the seven owner columns the admin DTO has no field for, so
    // a house-authored row asserts nothing about a business it has not spoken
    // to. It does NOT prove the `OmitType` list is live: rejecting a body
    // that carries `ownerName` is the global `forbidNonWhitelisted`
    // ValidationPipe's job, which runs above this service and is covered
    // where the pipe is. The names in that list were checked against
    // `CreateListingDto` by hand.
    expect(savedRow()).toEqual(
      expect.objectContaining({
        ownerName: '',
        ownerRole: '',
        ownerBio: '',
        visibility: '',
        linkToProfile: false,
        consentOuting: false,
        consentGuide: false,
      }),
    );
    // The retired `contactEmail` is never written on any create path; the
    // column's own DB default fills it.
    expect(savedRow()).not.toHaveProperty('contactEmail');
  });

  it('publishes live when the admin chose live', async () => {
    const result = await service.adminCreate(ADMIN_ID, adminDto('live'));

    expect(savedRow()).toEqual(
      expect.objectContaining({ status: ListingStatus.Live }),
    );
    expect(result.status).toBe(ListingStatus.Live);
  });

  it('holds a review choice at review status and returns it that way', async () => {
    const result = await service.adminCreate(ADMIN_ID, adminDto('review'));

    expect(savedRow()).toEqual(
      expect.objectContaining({ status: ListingStatus.Review }),
    );
    expect(result.status).toBe(ListingStatus.Review);
    // `createWithUniqueSlug`'s base literal already hardcodes
    // `status: ListingStatus.Review`, so this case agrees with a dropped
    // status override as readily as with a working one. The live case above
    // is the one that proves the override reaches the row; this case pins
    // the review direction end to end, through to the returned DTO.
  });

  it('allocates the shared ref sequence and a unique slug', async () => {
    const year = new Date().getFullYear();
    const result = await service.adminCreate(ADMIN_ID, adminDto('review'));

    expect(result.ref).toBe(`QPL-${year}-0007`);
    expect(result.slug).toBe('lux-cafe');
  });

  it('announces to the moderation queue when the choice was review', async () => {
    await service.adminCreate(ADMIN_ID, adminDto('review'));

    expect(adminQueueNotifications.announce).toHaveBeenCalledTimes(1);
    expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
      AdminQueueKey.ListingSubmissions,
      'listing-new',
    );
  });

  it('announces nothing when the admin published it themselves', async () => {
    await service.adminCreate(ADMIN_ID, adminDto('live'));

    // A listing an admin published has already had the decision a moderator
    // would be asked to make, so it stays off somebody else's desk.
    expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
  });

  it('writes one staff_created audit row carrying the publish choice', async () => {
    await service.adminCreate(ADMIN_ID, adminDto('live'));

    expect(moderationEvents.save).toHaveBeenCalledTimes(1);
    expect(moderationEvents.save).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: 'listing-new',
        actorId: ADMIN_ID,
        action: ListingModerationAction.StaffCreated,
        fromStatus: null,
        toStatus: ListingStatus.Live,
      }),
    );
    const [event] = moderationEvents.save.mock.calls[0] as [
      { reason: string | null },
    ];
    expect(event.reason).toContain('published');
  });

  it('records the queue choice in the audit row when it went to review', async () => {
    await service.adminCreate(ADMIN_ID, adminDto('review'));

    const [event] = moderationEvents.save.mock.calls[0] as [
      { reason: string | null; toStatus: ListingStatus },
    ];
    expect(event.toStatus).toBe(ListingStatus.Review);
    expect(event.reason).toContain('queue');
  });

  it('returns the listing and still queues it when the audit write fails', async () => {
    moderationEvents.save.mockRejectedValueOnce(
      new Error('audit write failed'),
    );

    const result = await service.adminCreate(ADMIN_ID, adminDto('review'));

    // The listing is committed by this point. A 500 here would read as
    // "nothing was created" and the admin's retry would give the business a
    // second public page, so the audit failure is swallowed and logged.
    expect(result.ref).toBeDefined();
    expect(adminQueueNotifications.announce).toHaveBeenCalledTimes(1);
  });

  it('writes nothing to the audit trail when the listing never saved', async () => {
    listings.save.mockRejectedValueOnce(new Error('write failed'));

    await expect(
      service.adminCreate(ADMIN_ID, adminDto('review')),
    ).rejects.toThrow('write failed');
    expect(moderationEvents.save).not.toHaveBeenCalled();
    expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
  });

  it('leaves the member create path stamping an owner and an acceptance', async () => {
    // The two paths share `createWithUniqueSlug`. Widening it for the staff
    // stamps must leave a member submission exactly as it was: owned, in
    // review, with a server-clock acceptance and no authoring staff member.
    await service.create('owner-1', { name: 'Lux Café' } as CreateListingDto);

    const row = savedRow();
    expect(row).toEqual(
      expect.objectContaining({
        ownerId: 'owner-1',
        status: ListingStatus.Review,
      }),
    );
    expect(row.affirmingBaselineAcceptedAt).toBeInstanceOf(Date);
    // Asserted as an ABSENT key. `expect.objectContaining` runs `hasProperty`
    // before it compares values, and `normalizeCreate` omits this column while
    // `overrides` defaults to `{}`, so the member row carries no such own
    // property for the matcher to find. Writing it as
    // `objectContaining({ createdByStaffId: undefined })` would fail here
    // against an implementation that is correct.
    expect(row).not.toHaveProperty('createdByStaffId');
  });
});

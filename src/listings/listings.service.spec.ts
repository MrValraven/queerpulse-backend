import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { MediaCropService } from '../media-crops/media-crops.service';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
import { ReportsService } from '../reports/reports.service';
import { CreateListingDto } from './dto/create-listing.dto';
import { Profile } from '../users/entities/profile.entity';
import {
  ListingModerationAction,
  ListingModerationEvent,
} from './entities/listing-moderation-event.entity';
import { ListingQuestion } from './entities/listing-question.entity';
import { ListingReview } from './entities/listing-review.entity';
import {
  Listing,
  ListingStatus,
  SafeSpaceStatus,
} from './entities/listing.entity';
import { ListingsService } from './listings.service';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default (mirrors `companies.service.spec.ts`'s `qbStub`).
// Includes the search/counts additions (`leftJoin`/`andWhere`/`select`/
// `addSelect`/`groupBy`/`getRawMany`) `listQueue`'s search+counts (item #8/#9)
// need on top of the original pagination chain. `getManyAndCount`/
// `getRawMany` are declared explicitly (not just via the index signature) so
// a test can reassign their resolved value with `noUncheckedIndexedAccess`
// on without an `| undefined` false positive.
interface QueryBuilderStub extends Record<string, jest.Mock> {
  getManyAndCount: jest.Mock;
  getRawMany: jest.Mock;
}

const qbStub = (): QueryBuilderStub => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
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
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  return qb as QueryBuilderStub;
};

// Stand-in for the `EntityManager` `dataSource.transaction(...)` hands the
// callback in `setStatus`/`removeByModerator`/`bulkSetStatus`/`bulkRemove`.
// `save` supports both call shapes the real service uses:
// `manager.save(listingInstance)` (one arg — the `Listing` itself, mirrors
// `listings.save`'s "synthesize generated columns" precedent) and
// `manager.save(EntityClass, partialObject)` (two args — a moderation-event
// write). `getRepository` always returns the `listings` mock, the only
// entity the bulk methods fetch a manager-scoped repository for.
//
// Built ONCE per test (`beforeEach` assigns it to the outer `transactionManager`
// and `dataSource.transaction` always hands the SAME instance to the
// callback) rather than fresh inside the `dataSource.transaction` mock body —
// a fresh-per-call manager is unobservable from a test, so `manager.save`
// assertions on moderation-event writes would silently check nothing.
const buildTransactionManager = (listingsRepo: Record<string, jest.Mock>) => {
  const manager = {
    save: jest.fn((first: unknown, second?: object) => {
      if (second !== undefined) {
        return Promise.resolve({ id: 'event-1', ...second });
      }
      return Promise.resolve({
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        ...(first as object),
      });
    }),
    remove: jest.fn((entity: object) => Promise.resolve(entity)),
    getRepository: jest.fn(() => listingsRepo),
  };
  return manager;
};

const baseListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 'listing-1',
  ref: 'QPL-2026-0001',
  slug: 'lux-cafe',
  ownerId: 'owner-1',
  status: ListingStatus.Review,
  path: 'claim',
  verify: '',
  name: 'Lux Café',
  cats: [],
  hood: 'Arroios',
  city: '',
  timezone: '',
  badge: '',
  evidence: '',
  price: '',
  blurb: '',
  tagline: '',
  whatItIs: [],
  tags: [],
  goodFor: [],
  langs: [],
  online: false,
  address: '',
  geocoded: false,
  latitude: null,
  longitude: null,
  hours: {},
  hoursNote: '',
  social: { instagram: '', website: '', email: '', phone: '' },
  photos: { wide: '', d1: '', d2: '', vibe: '' },
  alt: { wide: '', d1: '', d2: '', vibe: '' },
  rel: '',
  ownerName: '',
  ownerRole: '',
  ownerBio: '',
  visibility: 'public',
  linkToProfile: false,
  contactEmail: '',
  notify: [],
  consentOuting: false,
  consentGuide: false,
  queerOwnedVerified: false,
  isPartneredWithQueerpulse: false,
  spaceType: '',
  capacity: null,
  hostNote: '',
  safeSpaceStatus: SafeSpaceStatus.None,
  safeSpaceTier: null,
  safeSpaceVerifier: '',
  safeSpaceReVerifiedAt: null,
  safeSpaceSub: '',
  safeSpacePromises: [],
  safeSpaceVouches: [],
  safeSpaceRemoval: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('ListingsService', () => {
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
  let profiles: { find: jest.Mock; findOne: jest.Mock };
  let reviews: { findOne: jest.Mock; save: jest.Mock };
  let moderationEvents: { save: jest.Mock; find: jest.Mock };
  let questions: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let messaging: { deliverEnquiry: jest.Mock };
  let notifications: { create: jest.Mock };
  let dataSource: { query: jest.Mock; transaction: jest.Mock };
  // The stub `EntityManager` every `dataSource.transaction(...)` call in a
  // given test is handed — see `buildTransactionManager`'s doc comment for
  // why this must be a single instance rather than built fresh per call.
  let transactionManager: ReturnType<typeof buildTransactionManager>;

  beforeEach(async () => {
    listings = {
      findOne: jest.fn(),
      // Backs `bulkSetStatus`/`bulkRemove`'s single batched prefetch
      // (`find({ where: { ref: In(refs) } })`) instead of one `findOne` per
      // ref.
      find: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((v: object) => v),
      // Synthesizes generated columns so a mapper reading them off a
      // `save()` result never sees `undefined` (mirrors
      // `partners.service.spec.ts`'s identical precedent).
      save: jest.fn((v: object) =>
        Promise.resolve({
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...v,
        }),
      ),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    reviews = {
      findOne: jest.fn(),
      save: jest.fn((v: object) => Promise.resolve(v)),
    };
    moderationEvents = {
      save: jest.fn((v: object) => Promise.resolve({ id: 'event-1', ...v })),
      find: jest.fn().mockResolvedValue([]),
    };
    questions = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: object) =>
        Promise.resolve({
          id: 'question-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...v,
        }),
      ),
    };
    messaging = { deliverEnquiry: jest.fn() };
    notifications = { create: jest.fn() };
    transactionManager = buildTransactionManager(listings);
    dataSource = {
      query: jest.fn().mockResolvedValue([{ seq: '1' }]),
      // `setStatus`/`removeByModerator`/`bulkSetStatus`/`bulkRemove` all run
      // their writes through `dataSource.transaction(...)` — invoke the
      // callback with the single, per-test `transactionManager` stub (scoped
      // to the `listings` mock) rather than a real transaction, so a test can
      // assert on `transactionManager.save`/`.remove` afterward.
      transaction: jest.fn(
        (work: (manager: EntityManager) => Promise<unknown>) =>
          work(transactionManager as unknown as EntityManager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(ListingReview), useValue: reviews },
        {
          provide: getRepositoryToken(ListingModerationEvent),
          useValue: moderationEvents,
        },
        { provide: getRepositoryToken(ListingQuestion), useValue: questions },
        { provide: DataSource, useValue: dataSource },
        { provide: MessagingService, useValue: messaging },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: StorageService,
          useValue: { deleteObjectByReference: jest.fn() },
        },
        // Item #13: disputes + owner-notify tasks file through the shared
        // reports pipeline. `create` is only reached for friendly/suggested
        // listings, so a bare mock suffices for the existing cases.
        { provide: ReportsService, useValue: { create: jest.fn() } },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
      ],
    }).compile();
    service = module.get(ListingsService);
  });

  describe('create', () => {
    it('allocates a QPL-<year>-<seq> ref and a slug, defaulting to Review', async () => {
      const dto = { name: 'Lux Café' } as CreateListingDto;
      const result = await service.create('owner-1', dto);

      const year = new Date().getFullYear();
      expect(result.ref).toBe(`QPL-${year}-0001`);
      expect(result.slug).toBe('lux-cafe');
      expect(result.status).toBe(ListingStatus.Review);
      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'owner-1',
          status: ListingStatus.Review,
          name: 'Lux Café',
        }),
      );
    });

    it('defaults every optional draft field so nothing is undefined', async () => {
      await service.create('owner-1', { name: 'Lux Café' } as CreateListingDto);

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          cats: [],
          tags: [],
          social: { instagram: '', website: '', email: '', phone: '' },
          photos: { wide: '', d1: '', d2: '', vibe: '' },
          consentOuting: false,
        }),
      );
    });

    it('retries the slug on a 23505 unique-violation race', async () => {
      listings.exists
        .mockResolvedValueOnce(true) // first candidate taken
        .mockResolvedValueOnce(false);

      const result = await service.create('owner-1', {
        name: 'Lux Café',
      } as CreateListingDto);
      expect(result.slug).toBeDefined();
      expect(listings.exists).toHaveBeenCalledTimes(2);
    });
  });

  describe('listMine', () => {
    it('scopes the query to the caller and paginates', async () => {
      await service.listMine('owner-1', { page: 2 });

      const qb = listings.createQueryBuilder.mock.results[0]!.value as {
        where: jest.Mock;
        skip: jest.Mock;
      };
      expect(qb.where).toHaveBeenCalledWith('l.owner_id = :ownerId', {
        ownerId: 'owner-1',
      });
      expect(qb.skip).toHaveBeenCalled();
    });
  });

  describe('getByRef', () => {
    it('404s an unknown ref', async () => {
      listings.findOne.mockResolvedValue(null);
      await expect(
        service.getByRef('QPL-2026-9999', 'owner-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403s a caller who does not own the listing', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      await expect(
        service.getByRef('QPL-2026-0001', 'someone-else'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns the listing to its owner', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      const dto = await service.getByRef('QPL-2026-0001', 'owner-1');
      expect(dto.ref).toBe('QPL-2026-0001');
      expect(dto.name).toBe('Lux Café');
    });
  });

  describe('update', () => {
    it('403s a non-owner', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      await expect(
        service.update('QPL-2026-0001', 'someone-else', { blurb: 'nope' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(listings.save).not.toHaveBeenCalled();
    });

    it('patches only the given fields for the owner', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({ ownerId: 'owner-1', blurb: 'old' }),
      );

      const dto = await service.update('QPL-2026-0001', 'owner-1', {
        blurb: 'new blurb',
      });

      expect(dto.blurb).toBe('new blurb');
      expect(dto.name).toBe('Lux Café'); // untouched field preserved
    });

    it('merges partial social/photos patches instead of replacing the whole object', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          ownerId: 'owner-1',
          social: {
            instagram: '@lux',
            website: '',
            email: 'a@b.com',
            phone: '',
          },
        }),
      );

      const dto = await service.update('QPL-2026-0001', 'owner-1', {
        social: { phone: '+351123' },
      });

      expect(dto.social).toEqual({
        instagram: '@lux',
        website: '',
        email: 'a@b.com',
        phone: '+351123',
      });
    });
  });

  describe('remove', () => {
    it('403s a non-owner and does not delete', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      await expect(
        service.remove('QPL-2026-0001', 'someone-else'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(listings.remove).not.toHaveBeenCalled();
    });

    it('removes the listing for its owner', async () => {
      const listing = baseListing({ ownerId: 'owner-1' });
      listings.findOne.mockResolvedValue(listing);

      await service.remove('QPL-2026-0001', 'owner-1');
      expect(listings.remove).toHaveBeenCalledWith(listing);
    });
  });

  describe('setStatus', () => {
    it('404s an unknown ref', async () => {
      listings.findOne.mockResolvedValue(null);
      await expect(
        service.setStatus('QPL-2026-9999', ListingStatus.Live, 'mod-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('transitions review -> live, records a status_changed event, and creates the ListingApproved notification (not a DM)', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          status: ListingStatus.Review,
          ownerId: 'owner-1',
          slug: 'lux-cafe',
        }),
      );
      const dto = await service.setStatus(
        'QPL-2026-0001',
        ListingStatus.Live,
        'mod-1',
      );
      expect(dto.status).toBe(ListingStatus.Live);
      expect(transactionManager.save).toHaveBeenCalledWith(
        ListingModerationEvent,
        expect.objectContaining({
          listingId: 'listing-1',
          actorId: 'mod-1',
          action: ListingModerationAction.StatusChanged,
          fromStatus: ListingStatus.Review,
          toStatus: ListingStatus.Live,
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'owner-1',
        NotificationType.ListingApproved,
        expect.objectContaining({ listingSlug: 'lux-cafe' }),
      );
      // No "send back" DM on an approval into Live — the persisted
      // ListingApproved notification above covers it.
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('transitions review -> question, records the event, and best-effort DMs the submitter with the reason', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          status: ListingStatus.Review,
          ownerId: 'owner-1',
          name: 'Lux Café',
        }),
      );
      const dto = await service.setStatus(
        'QPL-2026-0001',
        ListingStatus.Question,
        'mod-1',
        'need opening hours',
      );
      expect(dto.status).toBe(ListingStatus.Question);
      expect(transactionManager.save).toHaveBeenCalledWith(
        ListingModerationEvent,
        expect.objectContaining({
          listingId: 'listing-1',
          actorId: 'mod-1',
          action: ListingModerationAction.StatusChanged,
          fromStatus: ListingStatus.Review,
          toStatus: ListingStatus.Question,
          reason: 'need opening hours',
        }),
      );
      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'mod-1',
        'owner-1',
        expect.stringContaining('need opening hours'),
      );
      // Not an approval — no persisted notification.
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('replyToReview', () => {
    const baseReview = {
      id: 'review-1',
      listingId: 'listing-1',
      reviewerId: 'member-1',
      reviewerName: 'Alex',
      byline: 'they/them',
      stars: 5,
      text: 'Loved it',
      helpful: 0,
      ownerReplyText: null,
      ownerRepliedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    it('404s an unknown listing ref', async () => {
      listings.findOne.mockResolvedValue(null);
      await expect(
        service.replyToReview('QPL-2026-9999', 'owner-1', 'review-1', {
          text: 'Thanks!',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('403s a caller who does not own the listing', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      await expect(
        service.replyToReview('QPL-2026-0001', 'someone-else', 'review-1', {
          text: 'Thanks!',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reviews.findOne).not.toHaveBeenCalled();
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('404s a review that does not belong to this listing', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      reviews.findOne.mockResolvedValue(null);

      await expect(
        service.replyToReview('QPL-2026-0001', 'owner-1', 'review-1', {
          text: 'Thanks!',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(reviews.findOne).toHaveBeenCalledWith({
        where: { id: 'review-1', listingId: 'listing-1' },
      });
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('400s a whitespace-only reply without saving', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      reviews.findOne.mockResolvedValue({ ...baseReview });

      await expect(
        service.replyToReview('QPL-2026-0001', 'owner-1', 'review-1', {
          text: '   ',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('sets a trimmed reply + timestamp for the owner', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      reviews.findOne.mockResolvedValue({ ...baseReview });

      const dto = await service.replyToReview(
        'QPL-2026-0001',
        'owner-1',
        'review-1',
        { text: '  Thanks for the kind words!  ' },
      );

      expect(reviews.save).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerReplyText: 'Thanks for the kind words!',
          ownerRepliedAt: expect.any(Date) as unknown,
        }),
      );
      expect(dto.ownerReply).toEqual({
        text: 'Thanks for the kind words!',
        at: expect.any(String) as unknown,
      });
    });

    it('overwrites an existing reply', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      reviews.findOne.mockResolvedValue({
        ...baseReview,
        ownerReplyText: 'Old reply',
        ownerRepliedAt: new Date('2026-01-02T00:00:00.000Z'),
      });

      const dto = await service.replyToReview(
        'QPL-2026-0001',
        'owner-1',
        'review-1',
        { text: 'New reply' },
      );

      expect(dto.ownerReply?.text).toBe('New reply');
    });
  });

  describe('listQueue', () => {
    it('applies status/search/sort filters and computes per-status counts with one grouped query', async () => {
      const searchQb = qbStub();
      const countsQb = qbStub();
      countsQb.getRawMany.mockResolvedValue([
        { status: ListingStatus.Review, count: '2' },
        { status: ListingStatus.Live, count: '5' },
      ]);
      // `listQueue` builds two independent query builders (the page + the
      // counts) — see `createQueryBuilder`'s call order in the service.
      listings.createQueryBuilder
        .mockReturnValueOnce(searchQb)
        .mockReturnValueOnce(countsQb);

      const result = await service.listQueue({
        status: ListingStatus.Review,
        q: 'lux',
        sort: 'name',
      });

      expect(searchQb.leftJoin).toHaveBeenCalled();
      expect(searchQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('ILIKE') as unknown,
        { pattern: '%lux%' },
      );
      expect(searchQb.orderBy).toHaveBeenCalledWith('l.name', 'ASC');
      // Exactly one grouped counts query — never one query per status.
      expect(countsQb.getRawMany).toHaveBeenCalledTimes(1);
      expect(result.counts).toEqual({
        all: 7,
        review: 2,
        question: 0,
        live: 5,
      });
    });
  });

  describe('bulkSetStatus', () => {
    it('bulk-approves found refs to Live: records a bulk_status event, creates the ListingApproved notification (not a DM), and reports unknown refs as failed', async () => {
      const listing = baseListing({
        ref: 'QPL-2026-0001',
        ownerId: 'owner-1',
        slug: 'lux-cafe',
        status: ListingStatus.Review,
      });
      listings.find.mockResolvedValue([listing]);

      const result = await service.bulkSetStatus(
        ['QPL-2026-0001', 'QPL-2026-9999'],
        ListingStatus.Live,
        'mod-1',
        'batch approve',
      );

      expect(result).toEqual({
        updated: ['QPL-2026-0001'],
        failed: ['QPL-2026-9999'],
      });
      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ListingStatus.Live }),
      );
      expect(transactionManager.save).toHaveBeenCalledWith(
        ListingModerationEvent,
        expect.objectContaining({
          listingId: 'listing-1',
          actorId: 'mod-1',
          action: ListingModerationAction.BulkStatus,
          fromStatus: ListingStatus.Review,
          toStatus: ListingStatus.Live,
          reason: 'batch approve',
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'owner-1',
        NotificationType.ListingApproved,
        expect.objectContaining({ listingSlug: 'lux-cafe' }),
      );
      // Bulk approval creates the persisted notification, never a DM.
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('best-effort DMs each affected submitter and records the event on a non-approval bulk transition', async () => {
      const listing = baseListing({
        ref: 'QPL-2026-0001',
        ownerId: 'owner-1',
        name: 'Lux Café',
        status: ListingStatus.Live,
      });
      listings.find.mockResolvedValue([listing]);

      await service.bulkSetStatus(
        ['QPL-2026-0001'],
        ListingStatus.Review,
        'mod-1',
        'needs another look',
      );

      expect(transactionManager.save).toHaveBeenCalledWith(
        ListingModerationEvent,
        expect.objectContaining({
          action: ListingModerationAction.BulkStatus,
          fromStatus: ListingStatus.Live,
          toStatus: ListingStatus.Review,
          reason: 'needs another look',
        }),
      );
      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'mod-1',
        'owner-1',
        expect.stringContaining('needs another look'),
      );
      // Not an approval — no persisted notification.
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('counts an already-at-target-status ref as updated but writes no event, DM, or notification', async () => {
      const listing = baseListing({
        ref: 'QPL-2026-0001',
        ownerId: 'owner-1',
        status: ListingStatus.Live,
      });
      listings.find.mockResolvedValue([listing]);

      const result = await service.bulkSetStatus(
        ['QPL-2026-0001'],
        ListingStatus.Live,
        'mod-1',
      );

      expect(result).toEqual({ updated: ['QPL-2026-0001'], failed: [] });
      expect(listings.save).not.toHaveBeenCalled();
      expect(transactionManager.save).not.toHaveBeenCalled();
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('bulkRemove', () => {
    it('removes found refs, records one removed event each, DMs submitters, and reports unknown refs as failed', async () => {
      const listing = baseListing({
        ref: 'QPL-2026-0001',
        ownerId: 'owner-1',
        name: 'Lux Café',
        status: ListingStatus.Live,
      });
      listings.find.mockResolvedValue([listing]);

      const result = await service.bulkRemove(
        ['QPL-2026-0001', 'QPL-2026-9999'],
        'mod-1',
        'policy violation',
      );

      expect(result).toEqual({
        updated: ['QPL-2026-0001'],
        failed: ['QPL-2026-9999'],
      });
      expect(listings.remove).toHaveBeenCalledWith(listing);
      expect(transactionManager.save).toHaveBeenCalledWith(
        ListingModerationEvent,
        expect.objectContaining({
          listingId: 'listing-1',
          actorId: 'mod-1',
          action: ListingModerationAction.Removed,
          fromStatus: ListingStatus.Live,
          toStatus: null,
          reason: 'policy violation',
        }),
      );
      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'mod-1',
        'owner-1',
        expect.stringContaining('policy violation'),
      );
    });
  });

  describe('getListingHistory', () => {
    it('404s an unknown ref', async () => {
      listings.findOne.mockResolvedValue(null);
      await expect(
        service.getListingHistory('QPL-2026-9999'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns events and questions, both newest-first per the repo query', async () => {
      listings.findOne.mockResolvedValue(baseListing());
      moderationEvents.find.mockResolvedValue([
        {
          id: 'event-1',
          listingId: 'listing-1',
          actorId: 'mod-1',
          action: ListingModerationAction.StatusChanged,
          fromStatus: ListingStatus.Review,
          toStatus: ListingStatus.Live,
          reason: null,
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ]);
      questions.find.mockResolvedValue([
        {
          id: 'question-1',
          listingId: 'listing-1',
          askedBy: 'mod-1',
          body: 'What are your hours?',
          answer: null,
          answeredAt: null,
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ]);

      const history = await service.getListingHistory('QPL-2026-0001');

      expect(moderationEvents.find).toHaveBeenCalledWith(
        expect.objectContaining({ order: { createdAt: 'DESC' } }),
      );
      expect(questions.find).toHaveBeenCalledWith(
        expect.objectContaining({ order: { createdAt: 'DESC' } }),
      );
      expect(history.events).toHaveLength(1);
      expect(history.events[0]?.action).toBe(
        ListingModerationAction.StatusChanged,
      );
      expect(history.questions).toHaveLength(1);
      expect(history.questions[0]?.body).toBe('What are your hours?');
    });
  });

  describe('answerQuestion', () => {
    it('403s a non-owner', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      await expect(
        service.answerQuestion(
          'QPL-2026-0001',
          'question-1',
          'someone-else',
          'Sure, opens at 9am.',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s a question that does not belong to this listing', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      questions.findOne.mockResolvedValue(null);

      await expect(
        service.answerQuestion(
          'QPL-2026-0001',
          'question-1',
          'owner-1',
          'Sure, opens at 9am.',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sets the answer + timestamp and records an answered event', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      questions.findOne.mockResolvedValue({
        id: 'question-1',
        listingId: 'listing-1',
        askedBy: 'mod-1',
        body: 'What are your hours?',
        answer: null,
        answeredAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const dto = await service.answerQuestion(
        'QPL-2026-0001',
        'question-1',
        'owner-1',
        'We open at 9am.',
      );

      expect(dto.answer).toBe('We open at 9am.');
      expect(dto.answeredAt).toEqual(expect.any(String) as unknown);
      expect(moderationEvents.save).toHaveBeenCalledWith(
        expect.objectContaining({ action: ListingModerationAction.Answered }),
      );
    });
  });
});

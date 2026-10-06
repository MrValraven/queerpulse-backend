import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { HousingViewingsService } from '../housing-viewings/housing-viewings.service';
import { MessagingService } from '../messaging/messaging.service';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import {
  HousingListerKind,
  HousingListing,
  HousingListingStatus,
  HousingListingType,
} from './entities/housing-listing.entity';
import { GeocodeService } from '../geocode/geocode.service';
import { HousingListingsService } from './housing-listings.service';

type RepoMock = Record<string, jest.Mock>;
type QueryBuilderStub = Record<string, jest.Mock>;

function makePaginatedBuilder(
  rows: unknown[],
  total: number,
): QueryBuilderStub {
  const builder: QueryBuilderStub = {};
  for (const method of ['where', 'orderBy', 'skip', 'take']) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }
  builder.getManyAndCount = jest.fn().mockResolvedValue([rows, total]);
  return builder;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function makeListing(overrides: Partial<HousingListing> = {}): HousingListing {
  return {
    id: 'listing-1',
    ref: 'QPH-2026-0001',
    slug: 'sunny-room',
    ownerId: 'owner-1',
    status: HousingListingStatus.Live,
    type: HousingListingType.Room,
    // Column default — member vs agent/broker disclosure badge.
    listerKind: HousingListerKind.Member,
    title: 'Sunny room',
    blurb: '',
    city: 'Lisbon',
    area: '',
    rentEuros: 500,
    depositEuros: null,
    // Null = bedroom count not specified (additive nullable column; old rows
    // never backfilled).
    bedrooms: null,
    billsIncluded: false,
    lgbtqFriendly: true,
    availableFrom: null,
    minStayMonths: null,
    description: '',
    features: [],
    idealFor: [],
    gallery: [],
    latitude: null,
    longitude: null,
    addressLine: null,
    // Column default `''` for old rows (required going forward, enforced by
    // `CreateHousingListingDto`, not nullable at the DB).
    accessibilityInfo: '',
    // Column defaults — deterministic pre-publish risk score/reasons, never
    // exposed on public browse.
    riskScore: 0,
    riskReasons: [],
    // LOC-01 decision trail — null until a moderator has decided on the row.
    decisionReason: null,
    decidedById: null,
    decidedAt: null,
    firstLiveAt: null,
    // Null = lister added no virtual-tour link.
    virtualTourUrl: null,
    // Null = still looking / still live to the public (owner hasn't marked it
    // filled and the sweeper hasn't hidden it).
    filledAt: null,
    // PRD-444: the expiry sweep did not write the current `filledAt`.
    sweptAt: null,
    // NOT NULL on the entity — every listing always carries a real expiry.
    // Relative to NOW so "live" fixtures read as not-yet-expired whatever the
    // wall clock says: `loadLiveOr404` 404s an expired listing (ENG-471).
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    // PRD-244: not yet warned about this term.
    expiryWarningSentAt: null,
    // ENG-467: never relisted after a fill.
    relistedAt: null,
    // ENG-469: no failed geocode of the current address.
    geocodeAttempts: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const CREATE_DTO = {
  type: HousingListingType.Room,
  title: 'Sunny room',
  city: 'Lisbon',
  rentEuros: 500,
  // Required on `CreateHousingListingDto`, and read without a fallback by
  // `assessHousingRisk` (`accessibilityInfo.trim()` for the
  // `missing_accessibility_info` signal) — omitting it here only ever passed
  // because the scorer used to be handed a defaulted value.
  accessibilityInfo: '',
} as never;

describe('HousingListingsService', () => {
  let service: HousingListingsService;
  // Declared with the exact method shape (rather than the bare `RepoMock`
  // index-signature alias) so `listings.findOne.mockResolvedValue(...)`-style
  // chained access doesn't see `noUncheckedIndexedAccess`'s `| undefined`.
  let listings: {
    findOne: jest.Mock;
    find: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock<Promise<HousingListing>, [HousingListing]>;
    remove: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: RepoMock;
  let dataSource: { query: jest.Mock };
  let messaging: {
    deliverEnquiry: jest.Mock;
    enquiryContactability: jest.Mock;
  };
  let verification: {
    requireLevel: jest.Mock;
    levelForUser: jest.Mock;
    levelsForUsers: jest.Mock;
  };
  let affirmingPledge: { requireAccepted: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let adminQueueNotifications: { announce: jest.Mock };
  let geocode: { resolveAddress: jest.Mock };
  let viewings: { closeOpenForListing: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };

  beforeEach(async () => {
    listings = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((row: unknown) => row),
      save: jest.fn((row: HousingListing) => Promise.resolve(row)),
      remove: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => makePaginatedBuilder([], 0)),
    };
    // buildDTO / mapRows hydrate the lister via MemberLookup(profiles).find.
    profiles = { find: jest.fn().mockResolvedValue([]) };
    dataSource = {
      query: jest.fn().mockResolvedValue([{ seq: '1' }]),
    };
    messaging = {
      deliverEnquiry: jest.fn().mockResolvedValue({ conversationId: 'conv-1' }),
      enquiryContactability: jest.fn().mockResolvedValue({
        canDeliver: true,
        blockedReason: null,
        replyRequiresConnection: true,
        followUpAwaitsReply: true,
      }),
    };
    verification = {
      requireLevel: jest.fn().mockResolvedValue(undefined),
      levelForUser: jest.fn().mockResolvedValue(VerificationLevel.Email),
      levelsForUsers: jest.fn().mockResolvedValue(new Map()),
    };
    affirmingPledge = {
      requireAccepted: jest.fn().mockResolvedValue(undefined),
    };
    eventEmitter = { emit: jest.fn() };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };
    geocode = {
      resolveAddress: jest
        .fn()
        .mockResolvedValue({ latitude: 38.7169, longitude: -9.1487 }),
    };
    viewings = {
      closeOpenForListing: jest.fn().mockResolvedValue(undefined),
    };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HousingListingsService,
        { provide: getRepositoryToken(HousingListing), useValue: listings },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: MessagingService, useValue: messaging },
        { provide: VerificationService, useValue: verification },
        { provide: AffirmingPledgeService, useValue: affirmingPledge },
        { provide: EventEmitter2, useValue: eventEmitter },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
        // The address geocoder. Stubbed rather than exercised: the service only
        // calls it for a listing that HAS an address, off the request path and
        // without awaiting it, so nothing here should ever reach the network.
        { provide: GeocodeService, useValue: geocode },
        { provide: HousingViewingsService, useValue: viewings },
        { provide: ContentModerationService, useValue: contentModeration },
      ],
    }).compile();

    service = module.get(HousingListingsService);
    // `toHousingListingDTO` resolves every gallery storage key through
    // `toImageUrl`, which throws `Service temporarily unavailable` when the
    // base was never wired. Only fixtures WITH a gallery hit it, which is why
    // this bites one test and not the rest.
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  /**
   * `HousingListingsService` loads owner-managed listings through
   * `loadOwnedOr404`, a single owner-scoped `findOne({ where: { ref, ownerId }})`
   * that replaced the old load-then-`assertOwner` pair. A stranger's `ref`
   * therefore misses the query entirely, so the repository mock has to honour
   * the `ownerId` in the where-clause instead of returning the row to anyone.
   */
  function mockOwnedFindOne(listing: HousingListing): void {
    listings.findOne.mockImplementation(
      (options: { where: { ref?: string; ownerId?: string } }) => {
        const { ref, ownerId } = options.where;
        if (ref !== undefined && ref !== listing.ref)
          return Promise.resolve(null);
        if (ownerId !== undefined && ownerId !== listing.ownerId) {
          return Promise.resolve(null);
        }
        return Promise.resolve(listing);
      },
    );
  }

  describe('create', () => {
    it('allocates a QPH ref from the sequence and forces Review status', async () => {
      dataSource.query.mockResolvedValue([{ seq: '7' }]);
      // Echo the created row back through the fixture so the DB-populated
      // createdAt the DTO mapper serialises is present.
      listings.save.mockImplementation((row: unknown) =>
        Promise.resolve(makeListing({ ...(row as object) })),
      );

      const result = await service.create('owner-1', CREATE_DTO);

      expect(listings.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ref: `QPH-${new Date().getFullYear()}-0007`,
          ownerId: 'owner-1',
          status: HousingListingStatus.Review,
        }),
      );
      expect(result.ref).toBe(`QPH-${new Date().getFullYear()}-0007`);
      expect(result.status).toBe(HousingListingStatus.Review);
    });

    // BE-HSG-07: LGBTQ+ affirming is a mandatory universal baseline, carried by
    // the pledge every lister accepts before posting — never a per-listing
    // opt-in. The submitted boolean is accepted (so `forbidNonWhitelisted`
    // doesn't 400 an older client) and ignored.
    it('forces lgbtqFriendly true regardless of what the submission sent', async () => {
      listings.save.mockImplementation((row: unknown) =>
        Promise.resolve(makeListing({ ...(row as object) })),
      );

      await service.create('owner-1', {
        ...(CREATE_DTO as object),
        lgbtqFriendly: false,
      } as never);

      expect(listings.create).toHaveBeenCalledWith(
        expect.objectContaining({ lgbtqFriendly: true }),
      );
    });

    // LOC-09: the backend owns the city. QueerPulse housing is Lisbon-only, so
    // an omitted or empty city is not a validation error, it is a value the
    // server fills in. Before this the column held whatever the form sent, and
    // the form sent `city: area.trim()`.
    it('stores "Lisbon" when the submission sends an empty city', async () => {
      listings.save.mockImplementation((row: unknown) =>
        Promise.resolve(makeListing({ ...(row as object) })),
      );

      await service.create('owner-1', {
        ...(CREATE_DTO as object),
        city: '',
      } as never);

      expect(listings.create).toHaveBeenCalledWith(
        expect.objectContaining({ city: 'Lisbon' }),
      );
    });

    it('stores "Lisbon" when the submission sends no city at all', async () => {
      listings.save.mockImplementation((row: unknown) =>
        Promise.resolve(makeListing({ ...(row as object) })),
      );
      const { city: _omitted, ...withoutCity } = CREATE_DTO as {
        city?: string;
      };

      await service.create('owner-1', withoutCity as never);

      expect(listings.create).toHaveBeenCalledWith(
        expect.objectContaining({ city: 'Lisbon' }),
      );
    });

    // The shape the old "List a space" form actually produced: the
    // neighbourhood in the city field, and no area at all. The neighbourhood is
    // kept (it is real data the lister typed) and moved to the column that
    // powers the centroid pin, the browse filter and saved-search matching.
    it('moves a neighbourhood sent as the city into area, and still stores "Lisbon"', async () => {
      listings.save.mockImplementation((row: unknown) =>
        Promise.resolve(makeListing({ ...(row as object) })),
      );

      await service.create('owner-1', {
        ...(CREATE_DTO as object),
        city: 'Arroios',
      } as never);

      expect(listings.create).toHaveBeenCalledWith(
        expect.objectContaining({ city: 'Lisbon', area: 'Arroios' }),
      );
    });

    // Markup is stripped ONCE, here at the write boundary, so no reader has to.
    it('strips markup from every member-typed field before storing it', async () => {
      listings.save.mockImplementation((row: unknown) =>
        Promise.resolve(makeListing({ ...(row as object) })),
      );

      await service.create('owner-1', {
        ...(CREATE_DTO as object),
        title: '<b>Sunny</b> room',
        description: '<script>alert(1)</script>A bright room.',
        idealFor: ['<i>students</i>'],
      } as never);

      expect(listings.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Sunny room',
          description: 'A bright room.',
          idealFor: ['students'],
        }),
      );
    });

    // The affirming pledge gates posting at all — no pledge, no listing.
    it('requires the affirming pledge before anything is allocated', async () => {
      affirmingPledge.requireAccepted.mockRejectedValue(
        new ForbiddenException('AFFIRMING_PLEDGE_REQUIRED'),
      );

      await expect(service.create('owner-1', CREATE_DTO)).rejects.toThrow(
        ForbiddenException,
      );
      expect(listings.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    it('tells the housing-listing queue that a listing landed in review', async () => {
      listings.save.mockImplementation((row: unknown) =>
        Promise.resolve(makeListing({ ...(row as object) })),
      );

      await service.create('owner-1', CREATE_DTO);

      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.HousingListings,
        'listing-1',
      );
    });

    // ENG-466: the unique slug index still covers a soft-deleted listing, so
    // the allocator must see those slugs as taken or a repost 409s.
    it('checks slug availability against soft-deleted listings too', async () => {
      listings.save.mockImplementation((row: unknown) =>
        Promise.resolve(makeListing({ ...(row as object) })),
      );

      await service.create('owner-1', CREATE_DTO);

      expect(listings.exists).toHaveBeenCalledWith({
        where: { slug: 'sunny-room' },
        withDeleted: true,
      });
    });

    it('tells nobody when the verification step-up is refused', async () => {
      verification.requireLevel.mockRejectedValue(
        new ForbiddenException('VERIFICATION_REQUIRED'),
      );

      await expect(service.create('owner-1', CREATE_DTO)).rejects.toThrow(
        ForbiddenException,
      );
      expect(listings.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });
  });

  describe('listMine', () => {
    it('scopes the paginated query to the owner and returns an envelope', async () => {
      const builder = makePaginatedBuilder([makeListing()], 1);
      listings.createQueryBuilder.mockReturnValue(builder);

      const result = await service.listMine('owner-1', { page: 1 });

      expect(builder.where).toHaveBeenCalledWith('l.owner_id = :ownerId', {
        ownerId: 'owner-1',
      });
      expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(result.items).toHaveLength(1);
    });
  });

  describe('getByRef', () => {
    it('404s on an unknown ref', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(service.getByRef('QPH-x', 'owner-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    // Ownership is folded into the query (`loadOwnedOr404`), so someone else's
    // listing 404s exactly like a non-existent ref rather than 403-ing. Refs are
    // a monotonic sequence, so a 403/404 split would be an existence oracle.
    it('404s (not 403s) when the caller is not the owner', async () => {
      mockOwnedFindOne(makeListing({ ownerId: 'owner-1' }));

      await expect(
        service.getByRef('QPH-2026-0001', 'intruder'),
      ).rejects.toThrow(NotFoundException);
      expect(listings.findOne).toHaveBeenCalledWith({
        where: { ref: 'QPH-2026-0001', ownerId: 'intruder' },
      });
    });

    it('returns the DTO for the owning caller', async () => {
      mockOwnedFindOne(makeListing({ ownerId: 'owner-1' }));

      const result = await service.getByRef('QPH-2026-0001', 'owner-1');

      expect(result.ref).toBe('QPH-2026-0001');
    });
  });

  describe('update', () => {
    it('404s a non-owner before mutating', async () => {
      mockOwnedFindOne(makeListing({ ownerId: 'owner-1' }));

      await expect(
        service.update('QPH-2026-0001', 'intruder', { title: 'x' }),
      ).rejects.toThrow(NotFoundException);
      expect(listings.save).not.toHaveBeenCalled();
    });

    it('applies only the provided fields for the owner', async () => {
      mockOwnedFindOne(
        makeListing({ ownerId: 'owner-1', title: 'Old', city: 'Lisbon' }),
      );
      listings.save.mockImplementation((row: HousingListing) =>
        Promise.resolve(row),
      );

      const result = await service.update('QPH-2026-0001', 'owner-1', {
        title: 'New title',
      });

      // Untouched field preserved; provided field applied.
      expect(result.title).toBe('New title');
      expect(result.city).toBe('Lisbon');
    });

    // BE-HSG-02: moderation is no longer a one-shot check at approval. An owner
    // edit that touches any field a moderator actually reviewed (the copy, the
    // price, the location, the photos, the disclosures) sends a LIVE listing
    // back to `review`, so a clean-approved listing can't be patched into a
    // scam rent or a discriminatory description while staying browsable.
    describe('re-review on owner edits (BE-HSG-02)', () => {
      it('returns a live listing to review when a moderated field changes', async () => {
        mockOwnedFindOne(
          makeListing({
            ownerId: 'owner-1',
            status: HousingListingStatus.Live,
            description: 'A room.',
          }),
        );

        const result = await service.update('QPH-2026-0001', 'owner-1', {
          description: 'A room, pay the deposit before viewing.',
        });

        expect(result.status).toBe(HousingListingStatus.Review);
      });

      it('leaves a live listing live when the moderated fields are re-sent unchanged', async () => {
        mockOwnedFindOne(
          makeListing({
            ownerId: 'owner-1',
            status: HousingListingStatus.Live,
            title: 'Sunny room',
          }),
        );

        const result = await service.update('QPH-2026-0001', 'owner-1', {
          title: 'Sunny room',
        });

        expect(result.status).toBe(HousingListingStatus.Live);
      });

      // Scheduling facts carry no moderatable content, so they stay
      // self-service — an owner can keep their dates honest without waiting on
      // a human.
      it('keeps scheduling-only edits self-service on a live listing', async () => {
        mockOwnedFindOne(
          makeListing({
            ownerId: 'owner-1',
            status: HousingListingStatus.Live,
          }),
        );

        const result = await service.update('QPH-2026-0001', 'owner-1', {
          availableFrom: '2026-04-01',
          minStayMonths: 3,
        });

        expect(result.status).toBe(HousingListingStatus.Live);
      });

      // Same reason: taking your own home off browse (or renewing it) must
      // never queue behind a moderator.
      it('keeps markFilled / markAvailable / extend off the review path', async () => {
        const listing = makeListing({
          ownerId: 'owner-1',
          status: HousingListingStatus.Live,
        });
        mockOwnedFindOne(listing);

        expect(
          (await service.markFilled('QPH-2026-0001', 'owner-1')).status,
        ).toBe(HousingListingStatus.Live);
        expect(
          (await service.markAvailable('QPH-2026-0001', 'owner-1')).status,
        ).toBe(HousingListingStatus.Live);
        expect((await service.extend('QPH-2026-0001', 'owner-1')).status).toBe(
          HousingListingStatus.Live,
        );
      });

      // A listing already in review has nothing to bounce out of.
      it('does not touch the status of a listing that was not live', async () => {
        mockOwnedFindOne(
          makeListing({
            ownerId: 'owner-1',
            status: HousingListingStatus.Review,
          }),
        );

        const result = await service.update('QPH-2026-0001', 'owner-1', {
          title: 'Another title',
        });

        expect(result.status).toBe(HousingListingStatus.Review);
      });
    });

    // ENG-469: a new address earns a fresh set of geocode retries.
    it('resets the geocode attempt count when the address changes', async () => {
      mockOwnedFindOne(
        makeListing({
          ownerId: 'owner-1',
          addressLine: 'Rua Velha 1',
          geocodeAttempts: 4,
        }),
      );

      await service.update('QPH-2026-0001', 'owner-1', {
        addressLine: 'Rua Nova 2',
      });

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          addressLine: 'Rua Nova 2',
          latitude: null,
          longitude: null,
          geocodeAttempts: 0,
        }),
      );
    });

    // BE-HSG-07 on the write side: the flag is not settable at all, so a PATCH
    // carrying it neither flips the column nor counts as a moderated change.
    it('ignores lgbtqFriendly on update — affirming is not a per-listing flag', async () => {
      mockOwnedFindOne(
        makeListing({ ownerId: 'owner-1', status: HousingListingStatus.Live }),
      );

      const result = await service.update('QPH-2026-0001', 'owner-1', {
        lgbtqFriendly: false,
      });

      expect(result.lgbtqFriendly).toBe(true);
      expect(result.status).toBe(HousingListingStatus.Live);
    });

    // BE-HSG-08: the scorer reads every member-typed string, so exclusionary
    // wording typed into the "ideal for" chips is caught the same as in the
    // description — it used to score 0 and sort to the bottom of the queue.
    it('re-scores discriminatory wording typed into idealFor', async () => {
      mockOwnedFindOne(
        makeListing({ ownerId: 'owner-1', status: HousingListingStatus.Live }),
      );

      await service.update('QPH-2026-0001', 'owner-1', {
        idealFor: ['traditional family'],
      });

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          riskReasons: expect.arrayContaining([
            'discriminatory_language',
          ]) as string[],
        }),
      );
    });

    // Finding M1: `HousingListingsController.update` keeps the interceptor's
    // foreign-upload exemption (co-listers edit the same listing), so the
    // service is the line that stops a member introducing a NEW gallery image
    // that is not theirs while still letting a co-lister re-save one a
    // different collaborator uploaded.
    describe('foreign gallery image ownership (M1)', () => {
      const OWNER_ID = 'owner-1';
      const OTHER_ID = '22222222-2222-2222-2222-222222222222';
      const FILE_SEGMENT = '33333333-3333-3333-3333-333333333333';
      // A well-formed key whose embedded owner segment is NOT the requester.
      const FOREIGN_KEY = `listing-photos/${OTHER_ID}/${FILE_SEGMENT}.jpg`;

      it('allows re-saving a gallery image the listing already carries', async () => {
        mockOwnedFindOne(
          makeListing({ ownerId: OWNER_ID, gallery: [FOREIGN_KEY] }),
        );
        await expect(
          service.update('QPH-2026-0001', OWNER_ID, {
            gallery: [FOREIGN_KEY],
          }),
        ).resolves.toBeDefined();
      });

      it('rejects a new foreign gallery image the listing does not carry', async () => {
        mockOwnedFindOne(makeListing({ ownerId: OWNER_ID, gallery: [] }));
        await expect(
          service.update('QPH-2026-0001', OWNER_ID, {
            gallery: [FOREIGN_KEY],
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(listings.save).not.toHaveBeenCalled();
      });
    });
  });

  describe('remove', () => {
    it('404s a non-owner', async () => {
      mockOwnedFindOne(makeListing({ ownerId: 'owner-1' }));

      await expect(service.remove('QPH-2026-0001', 'intruder')).rejects.toThrow(
        NotFoundException,
      );
      expect(listings.update).not.toHaveBeenCalled();
      expect(viewings.closeOpenForListing).not.toHaveBeenCalled();
    });

    // ENG-466: a hard delete cascaded to every viewing and review of the home.
    // The row now stays, so the private location is cleared in the same write.
    it('soft-deletes the listing with its address cleared, then closes its open viewings', async () => {
      const listing = makeListing({
        ownerId: 'owner-1',
        addressLine: 'Rua Secreta 1',
        latitude: 38.7169,
        longitude: -9.1487,
      });
      mockOwnedFindOne(listing);
      const callOrder: string[] = [];
      listings.update.mockImplementation(() => {
        callOrder.push('update');
        return Promise.resolve({ affected: 1 });
      });
      viewings.closeOpenForListing.mockImplementation(() => {
        callOrder.push('closeOpenForListing');
        return Promise.resolve();
      });

      await service.remove('QPH-2026-0001', 'owner-1');

      expect(listings.update).toHaveBeenCalledTimes(1);
      expect(listings.update).toHaveBeenCalledWith(
        { id: 'listing-1' },
        {
          addressLine: null,
          latitude: null,
          longitude: null,
          deletedAt: expect.any(Date) as Date,
        },
      );
      expect(listings.remove).not.toHaveBeenCalled();
      expect(viewings.closeOpenForListing).toHaveBeenCalledWith(
        'listing-1',
        'owner-1',
      );
      expect(callOrder).toEqual(['update', 'closeOpenForListing']);
    });
  });

  describe('owner lifecycle', () => {
    // ENG-467: nobody should travel to see a home that has been filled.
    it('closes the open viewings when the owner marks the listing filled', async () => {
      mockOwnedFindOne(makeListing({ ownerId: 'owner-1' }));

      const result = await service.markFilled('QPH-2026-0001', 'owner-1');

      expect(result.filledAt).not.toBeNull();
      expect(viewings.closeOpenForListing).toHaveBeenCalledWith(
        'listing-1',
        'owner-1',
      );
    });

    // PRD-444: an owner fill replaces a sweep fill, so Extend keeps it hidden.
    it('clears the sweep marker when the owner marks a swept listing filled', async () => {
      const lapsedAt = new Date(Date.now() - 2 * DAY_MS);
      mockOwnedFindOne(
        makeListing({
          ownerId: 'owner-1',
          expiresAt: lapsedAt,
          filledAt: new Date(lapsedAt.getTime() + 60 * 60 * 1000),
          sweptAt: new Date(lapsedAt.getTime() + 60 * 60 * 1000),
        }),
      );

      const result = await service.markFilled('QPH-2026-0001', 'owner-1');

      expect(result.isHiddenBySweep).toBe(false);
      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ sweptAt: null }),
      );
    });

    it('stamps relistedAt when the owner makes a filled listing available again', async () => {
      mockOwnedFindOne(
        makeListing({
          ownerId: 'owner-1',
          filledAt: new Date(Date.now() - DAY_MS),
          expiresAt: new Date(Date.now() + 10 * DAY_MS),
        }),
      );

      await service.markAvailable('QPH-2026-0001', 'owner-1');

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          filledAt: null,
          relistedAt: expect.any(Date) as Date,
        }),
      );
    });

    it('leaves relistedAt alone when the fill being undone came from the expiry sweep', async () => {
      const lapsedAt = new Date(Date.now() - 2 * DAY_MS);
      mockOwnedFindOne(
        makeListing({
          ownerId: 'owner-1',
          expiresAt: lapsedAt,
          filledAt: new Date(lapsedAt.getTime() + 60 * 60 * 1000),
          sweptAt: new Date(lapsedAt.getTime() + 60 * 60 * 1000),
        }),
      );

      await service.markAvailable('QPH-2026-0001', 'owner-1');

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          filledAt: null,
          sweptAt: null,
          relistedAt: null,
        }),
      );
    });

    // PRD-444: the owner filled it after the term ran out and before the sweep
    // got there. The fill is theirs, so undoing it is a relist.
    it('stamps relistedAt when undoing an owner fill made after the expiry', async () => {
      const lapsedAt = new Date(Date.now() - 2 * DAY_MS);
      mockOwnedFindOne(
        makeListing({
          ownerId: 'owner-1',
          expiresAt: lapsedAt,
          filledAt: new Date(lapsedAt.getTime() + 60 * 60 * 1000),
        }),
      );

      await service.markAvailable('QPH-2026-0001', 'owner-1');

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          filledAt: null,
          relistedAt: expect.any(Date) as Date,
        }),
      );
    });

    // PRD-444: extending a listing the sweep hid brings it back to browse.
    it('clears a sweep-set filledAt on extend and leaves relistedAt alone', async () => {
      const lapsedAt = new Date(Date.now() - 2 * DAY_MS);
      mockOwnedFindOne(
        makeListing({
          ownerId: 'owner-1',
          expiresAt: lapsedAt,
          filledAt: new Date(lapsedAt.getTime() + 60 * 60 * 1000),
          sweptAt: new Date(lapsedAt.getTime() + 60 * 60 * 1000),
        }),
      );

      const result = await service.extend('QPH-2026-0001', 'owner-1');

      expect(result.filledAt).toBeNull();
      expect(result.isHiddenBySweep).toBe(false);
      expect(result.expired).toBe(false);
      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ relistedAt: null, sweptAt: null }),
      );
    });

    // A moderator re-approval refreshed `expiresAt` past the sweep's fill, so
    // the fill time alone reads like an owner fill. The marker still holds.
    it('clears a sweep fill on extend after a re-approval refreshed the expiry', async () => {
      const sweptAt = new Date(Date.now() - 5 * DAY_MS);
      mockOwnedFindOne(
        makeListing({
          ownerId: 'owner-1',
          expiresAt: new Date(Date.now() + 50 * DAY_MS),
          filledAt: sweptAt,
          sweptAt,
        }),
      );

      const result = await service.extend('QPH-2026-0001', 'owner-1');

      expect(result.filledAt).toBeNull();
    });

    // The owner marked an already-expired listing filled before the sweep ran.
    // The fill time sits after the expiry, and it is still their own fill.
    it('keeps an owner fill made after the expiry in place on extend', async () => {
      const lapsedAt = new Date(Date.now() - 2 * DAY_MS);
      const ownerFilledAt = new Date(lapsedAt.getTime() + 60 * 60 * 1000);
      mockOwnedFindOne(
        makeListing({
          ownerId: 'owner-1',
          expiresAt: lapsedAt,
          filledAt: ownerFilledAt,
        }),
      );

      const result = await service.extend('QPH-2026-0001', 'owner-1');

      expect(result.filledAt).toBe(ownerFilledAt.toISOString());
      expect(result.isHiddenBySweep).toBe(false);
    });

    it('keeps an owner fill in place on extend', async () => {
      const ownerFilledAt = new Date(Date.now() - DAY_MS);
      mockOwnedFindOne(
        makeListing({
          ownerId: 'owner-1',
          filledAt: ownerFilledAt,
          expiresAt: new Date(Date.now() + 10 * DAY_MS),
        }),
      );

      const result = await service.extend('QPH-2026-0001', 'owner-1');

      expect(result.filledAt).toBe(ownerFilledAt.toISOString());
    });
  });

  describe('createEnquiry', () => {
    it('404s when the listing is not publicly live', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.createEnquiry('QPH-x', 'sender', { body: 'hi' }),
      ).rejects.toThrow(NotFoundException);
      expect(listings.findOne).toHaveBeenCalledWith({
        where: { ref: 'QPH-x', status: HousingListingStatus.Live },
      });
    });

    it('rejects an enquiry from the listing owner on their own listing', async () => {
      listings.findOne.mockResolvedValue(makeListing({ ownerId: 'owner-1' }));

      await expect(
        service.createEnquiry('QPH-2026-0001', 'owner-1', {
          body: 'hi',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('answers a blocked pair with the detail read 404 before the pledge and step-up', async () => {
      listings.findOne.mockResolvedValue(makeListing({ ownerId: 'owner-1' }));
      messaging.enquiryContactability.mockResolvedValue({
        canDeliver: false,
        blockedReason: 'blocked',
        replyRequiresConnection: false,
        followUpAwaitsReply: false,
      });

      await expect(
        service.createEnquiry('QPH-2026-0001', 'sender', { body: 'hi' }),
      ).rejects.toThrow(new NotFoundException('Housing listing not found'));
      expect(messaging.enquiryContactability).toHaveBeenCalledWith(
        'sender',
        'owner-1',
      );
      expect(affirmingPledge.requireAccepted).not.toHaveBeenCalled();
      expect(verification.requireLevel).not.toHaveBeenCalled();
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('delivers the enquiry to the lister and returns the conversation id', async () => {
      listings.findOne.mockResolvedValue(makeListing({ ownerId: 'owner-1' }));

      const result = await service.createEnquiry('QPH-2026-0001', 'sender', {
        body: 'Is it still available?',
      });

      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'sender',
        'owner-1',
        'Is it still available?',
      );
      expect(result).toEqual({ conversationId: 'conv-1' });
    });
  });

  describe('getEnquiryContact', () => {
    it('404s when the listing is not publicly live', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.getEnquiryContact('QPH-x', 'sender'),
      ).rejects.toThrow(NotFoundException);
      expect(messaging.enquiryContactability).not.toHaveBeenCalled();
    });

    it('reports false without consulting messaging on the caller’s own listing', async () => {
      listings.findOne.mockResolvedValue(makeListing({ ownerId: 'owner-1' }));

      const result = await service.getEnquiryContact(
        'QPH-2026-0001',
        'owner-1',
      );

      expect(result).toEqual({
        replyRequiresConnection: false,
        followUpAwaitsReply: false,
      });
      expect(messaging.enquiryContactability).not.toHaveBeenCalled();
    });

    it('reports false without consulting messaging once the lister has erased their account', async () => {
      listings.findOne.mockResolvedValue(makeListing({ ownerId: null }));

      const result = await service.getEnquiryContact('QPH-2026-0001', 'sender');

      expect(result).toEqual({
        replyRequiresConnection: false,
        followUpAwaitsReply: false,
      });
      expect(messaging.enquiryContactability).not.toHaveBeenCalled();
    });

    it('answers a blocked pair with the detail read 404', async () => {
      listings.findOne.mockResolvedValue(makeListing({ ownerId: 'owner-1' }));
      messaging.enquiryContactability.mockResolvedValue({
        canDeliver: false,
        blockedReason: 'blocked',
        replyRequiresConnection: false,
        followUpAwaitsReply: false,
      });

      await expect(
        service.getEnquiryContact('QPH-2026-0001', 'sender'),
      ).rejects.toThrow(new NotFoundException('Housing listing not found'));
    });

    it('reports the messaging module’s reply-requires-connection and follow-up-awaits-reply answers for a real recipient', async () => {
      listings.findOne.mockResolvedValue(makeListing({ ownerId: 'owner-1' }));

      const result = await service.getEnquiryContact('QPH-2026-0001', 'sender');

      expect(messaging.enquiryContactability).toHaveBeenCalledWith(
        'sender',
        'owner-1',
      );
      expect(result).toEqual({
        replyRequiresConnection: true,
        followUpAwaitsReply: true,
      });
    });
  });

  describe('loadLiveOr404', () => {
    it('404s a listing that is not live', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(service.loadLiveOr404('QPH-x')).rejects.toThrow(
        NotFoundException,
      );
    });

    // ENG-471: an enquiry about a home off the board is refused as a 404.
    it('404s a live listing the owner marked filled', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ filledAt: new Date(Date.now() - DAY_MS) }),
      );

      await expect(service.loadLiveOr404('QPH-2026-0001')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s a live listing whose term has run out', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ expiresAt: new Date(Date.now() - DAY_MS) }),
      );

      await expect(service.loadLiveOr404('QPH-2026-0001')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s a live listing under a moderator takedown', async () => {
      listings.findOne.mockResolvedValue(makeListing());
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(service.loadLiveOr404('QPH-2026-0001')).rejects.toThrow(
        NotFoundException,
      );
      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'housing',
        'sunny-room',
      );
    });

    it('returns a live listing that is still on the board', async () => {
      const listing = makeListing();
      listings.findOne.mockResolvedValue(listing);

      await expect(service.loadLiveOr404('QPH-2026-0001')).resolves.toBe(
        listing,
      );
    });
  });
});

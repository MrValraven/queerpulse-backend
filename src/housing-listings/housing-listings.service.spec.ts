import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
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
    // Null = lister added no virtual-tour link.
    virtualTourUrl: null,
    // Null = still looking / still live to the public (owner hasn't marked it
    // filled and the sweeper hasn't hidden it).
    filledAt: null,
    // NOT NULL on the entity — every listing always carries a real expiry.
    // Comfortably after the fixture's `createdAt` so "live" fixtures read as
    // not-yet-expired by default.
    expiresAt: new Date('2026-03-02T00:00:00.000Z'),
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
    save: jest.Mock;
    remove: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: RepoMock;
  let dataSource: { query: jest.Mock };
  let messaging: { deliverEnquiry: jest.Mock };
  let verification: {
    requireLevel: jest.Mock;
    levelForUser: jest.Mock;
    levelsForUsers: jest.Mock;
  };
  let affirmingPledge: { requireAccepted: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    listings = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((row: unknown) => row),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => makePaginatedBuilder([], 0)),
    };
    // buildDTO / mapRows hydrate the lister via MemberLookup(profiles).find.
    profiles = { find: jest.fn().mockResolvedValue([]) };
    dataSource = {
      query: jest.fn().mockResolvedValue([{ seq: '1' }]),
    };
    messaging = {
      deliverEnquiry: jest.fn().mockResolvedValue({ conversationId: 'conv-1' }),
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

    // The affirming pledge gates posting at all — no pledge, no listing.
    it('requires the affirming pledge before anything is allocated', async () => {
      affirmingPledge.requireAccepted.mockRejectedValue(
        new ForbiddenException('AFFIRMING_PLEDGE_REQUIRED'),
      );

      await expect(service.create('owner-1', CREATE_DTO)).rejects.toThrow(
        ForbiddenException,
      );
      expect(listings.save).not.toHaveBeenCalled();
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
      listings.save.mockImplementation((row: unknown) => Promise.resolve(row));

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
          riskReasons: expect.arrayContaining(['discriminatory_language']),
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
      expect(listings.remove).not.toHaveBeenCalled();
    });

    it('removes the listing for its owner', async () => {
      const listing = makeListing({ ownerId: 'owner-1' });
      mockOwnedFindOne(listing);

      await service.remove('QPH-2026-0001', 'owner-1');

      expect(listings.remove).toHaveBeenCalledWith(listing);
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

  describe('setStatus', () => {
    it('404s an unknown ref', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.setStatus('QPH-x', HousingListingStatus.Live),
      ).rejects.toThrow(NotFoundException);
    });

    it('directly sets any status (moderator path) and saves', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ status: HousingListingStatus.Review }),
      );
      listings.save.mockImplementation((row: unknown) => Promise.resolve(row));

      const result = await service.setStatus(
        'QPH-2026-0001',
        HousingListingStatus.Live,
      );

      expect(result.status).toBe(HousingListingStatus.Live);
    });
  });

  describe('loadLiveOr404', () => {
    it('404s a listing that is not live', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(service.loadLiveOr404('QPH-x')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

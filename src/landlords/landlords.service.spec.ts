import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { POSTGRES_UNIQUE_VIOLATION } from '../common/db-errors';
import { PAGE_SIZE } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import {
  LandlordIntroRequest,
  LandlordIntroRequestStatus,
} from './entities/landlord-intro-request.entity';
import { LandlordRecommendation } from './entities/landlord-recommendation.entity';
import { Landlord, LandlordStatus } from './entities/landlord.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { LandlordsService } from './landlords.service';

type RepoMock = Record<string, jest.Mock>;
type QueryBuilderStub = Record<string, jest.Mock>;

function makePaginatedBuilder(
  rows: unknown[],
  total: number,
): QueryBuilderStub {
  const builder: QueryBuilderStub = {};
  for (const method of [
    'where',
    'andWhere',
    'orderBy',
    'skip',
    'take',
    'offset',
    'limit',
  ]) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }
  builder.getManyAndCount = jest.fn().mockResolvedValue([rows, total]);
  return builder;
}

function makeLandlord(overrides: Partial<Landlord> = {}): Landlord {
  return {
    id: 'landlord-1',
    slug: 'friendly-landlord',
    status: LandlordStatus.Live,
    submittedByUserId: null,
    name: 'Friendly Landlord',
    hood: 'Arroios',
    photo: '',
    tagline: 'Welcoming to all',
    note: '',
    about: [],
    areas: [],
    rentingNote: '',
    stats: [],
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeRec(
  overrides: Partial<LandlordRecommendation> = {},
): LandlordRecommendation {
  return {
    id: 'rec-1',
    landlordId: 'landlord-1',
    authorUserId: 'author-1',
    stars: 5,
    text: 'Great!',
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function makeIntroRequest(
  overrides: Partial<LandlordIntroRequest> = {},
): LandlordIntroRequest {
  return {
    id: 'intro-1',
    landlordId: 'landlord-1',
    userId: null,
    user: null,
    name: 'Sam',
    note: null,
    contactEmail: null,
    status: LandlordIntroRequestStatus.Pending,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    createdAt: new Date('2026-01-03T00:00:00.000Z'),
    ...overrides,
  };
}

function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('duplicate key'), {
    code: POSTGRES_UNIQUE_VIOLATION,
  });
}

// The rating aggregate's query-builder stub: chainable, resolving to the
// "no recommendations yet" raw row by default. Tests that need a rating
// override `getRawOne`.
// Declared with the exact method shape (rather than a `Record<string,
// jest.Mock>` index signature) so `ratingQb.getRawOne.mockResolvedValue(...)`
// doesn't see `noUncheckedIndexedAccess`'s `| undefined`.
type RatingQueryBuilderStub = {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  getRawOne: jest.Mock;
};

const ratingQbStub = (): RatingQueryBuilderStub => {
  const qb: RatingQueryBuilderStub = {
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    getRawOne: jest.fn().mockResolvedValue({ average: null, count: '0' }),
  };
  qb.select.mockReturnValue(qb);
  qb.addSelect.mockReturnValue(qb);
  qb.where.mockReturnValue(qb);
  return qb;
};

describe('LandlordsService', () => {
  let service: LandlordsService;
  // Declared with the exact method shape (rather than the bare `RepoMock`
  // index-signature alias) so `landlords.findOne.mockResolvedValue(...)`-style
  // chained access doesn't see `noUncheckedIndexedAccess`'s `| undefined`.
  let landlords: {
    find: jest.Mock;
    findOne: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let recommendations: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let introRequests: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: RepoMock;
  let verification: {
    requireLevel: jest.Mock;
    levelForUser: jest.Mock;
    levelsForUsers: jest.Mock;
  };
  let affirmingPledge: { requireAccepted: jest.Mock };
  // LOC-19: every staff decision now reaches the member it is about.
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    landlords = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((row: unknown) => row),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => makePaginatedBuilder([], 0)),
    };
    recommendations = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: unknown) => row),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      remove: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      // One landlord's rating is aggregated in SQL (AVG + COUNT) rather than
      // summed in JS, so the detail view goes through the query builder.
      // Default: no recommendations yet.
      createQueryBuilder: jest.fn(() => ratingQbStub()),
    };
    introRequests = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: unknown) => row),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      createQueryBuilder: jest.fn(() => makePaginatedBuilder([], 0)),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    verification = {
      requireLevel: jest.fn().mockResolvedValue(undefined),
      levelForUser: jest.fn().mockResolvedValue(VerificationLevel.Email),
      levelsForUsers: jest.fn().mockResolvedValue(new Map()),
    };
    affirmingPledge = {
      requireAccepted: jest.fn().mockResolvedValue(undefined),
    };
    notifications = { create: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LandlordsService,
        { provide: getRepositoryToken(Landlord), useValue: landlords },
        {
          provide: getRepositoryToken(LandlordRecommendation),
          useValue: recommendations,
        },
        {
          provide: getRepositoryToken(LandlordIntroRequest),
          useValue: introRequests,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: VerificationService, useValue: verification },
        { provide: AffirmingPledgeService, useValue: affirmingPledge },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(LandlordsService);
    // The detail mapper resolves photos through `toImageUrl`, which throws
    // `Service temporarily unavailable` when the base was never wired. Only
    // storage-key fixtures reach it (the foreign-photo cases).
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('browse', () => {
    it('lists only live landlords with their aggregate rating', async () => {
      const builder = makePaginatedBuilder([makeLandlord()], 1);
      landlords.createQueryBuilder.mockReturnValue(builder);
      recommendations.find.mockResolvedValue([
        makeRec({ stars: 5 }),
        makeRec({ id: 'rec-2', stars: 3 }),
      ]);

      const result = await service.browse({ page: 1 });

      expect(builder.where).toHaveBeenCalledWith('l.status = :live', {
        live: LandlordStatus.Live,
      });
      expect(result.items[0]?.rating).toEqual({ score: '4.0', count: 2 });
    });

    it('applies the hood filter when supplied', async () => {
      const builder = makePaginatedBuilder([], 0);
      landlords.createQueryBuilder.mockReturnValue(builder);

      await service.browse({ hood: 'Arroios' });

      expect(builder.andWhere).toHaveBeenCalledWith(
        'LOWER(l.hood) = LOWER(:hood)',
        { hood: 'Arroios' },
      );
    });
  });

  describe('detail', () => {
    it('404s an unknown or non-live slug', async () => {
      landlords.findOne.mockResolvedValue(null);

      await expect(service.detail('ghost')).rejects.toThrow(NotFoundException);
    });

    it('assembles the detail view with recommendations and a computed rating', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      recommendations.find.mockResolvedValue([makeRec({ stars: 4 })]);
      // The rating is aggregated in SQL, not summed from the rows above, so
      // the raw AVG/COUNT is what the view reads.
      const ratingQb = ratingQbStub();
      ratingQb.getRawOne.mockResolvedValue({ average: '4', count: '1' });
      recommendations.createQueryBuilder.mockReturnValue(ratingQb);

      const result = await service.detail('friendly-landlord');

      expect(result.slug).toBe('friendly-landlord');
      expect(result.rating).toEqual({ score: '4.0', count: 1 });
      expect(result.recommendations).toHaveLength(1);
    });
  });

  describe('suggest', () => {
    it('creates a member-suggested landlord in Review status attributed to the user', async () => {
      landlords.exists.mockResolvedValue(false);
      landlords.save.mockImplementation((row: unknown) =>
        Promise.resolve(
          makeLandlord({ ...(row as object), id: 'landlord-new' }),
        ),
      );

      const result = await service.suggest('user-1', {
        name: 'New One',
      });

      expect(landlords.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: LandlordStatus.Review,
          submittedByUserId: 'user-1',
        }),
      );
      expect(result.slug).toBeDefined();
    });
  });

  describe('recommend', () => {
    it('404s when the landlord is not live', async () => {
      landlords.findOne.mockResolvedValue(null);

      await expect(
        service.recommend('ghost', 'author-1', {
          stars: 5,
          text: 'x',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('inserts a fresh recommendation when the author has none', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      recommendations.findOne.mockResolvedValue(null);
      recommendations.save.mockImplementation((row: unknown) =>
        Promise.resolve(makeRec({ ...(row as object) })),
      );

      const result = await service.recommend('friendly-landlord', 'author-1', {
        stars: 5,
        text: 'Wonderful',
      });

      expect(recommendations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          landlordId: 'landlord-1',
          authorUserId: 'author-1',
          stars: 5,
        }),
      );
      expect(result.stars).toBe(5);
    });

    it("upserts (overwrites) the author's existing recommendation", async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      const existing = makeRec({ stars: 2, text: 'meh' });
      recommendations.findOne.mockResolvedValue(existing);
      recommendations.save.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      const result = await service.recommend('friendly-landlord', 'author-1', {
        stars: 4,
        text: 'Better now',
      });

      expect(recommendations.create).not.toHaveBeenCalled();
      expect(recommendations.save).toHaveBeenCalledWith(
        expect.objectContaining({ stars: 4, text: 'Better now' }),
      );
      expect(result.stars).toBe(4);
    });

    it('recovers from a lost insert race (23505) by re-finding and updating', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      recommendations.findOne
        .mockResolvedValueOnce(null) // initial miss
        .mockResolvedValueOnce(makeRec({ stars: 1 })); // re-find after the clash
      recommendations.save
        .mockRejectedValueOnce(uniqueViolation())
        .mockImplementationOnce((row: unknown) => Promise.resolve(row));

      const result = await service.recommend('friendly-landlord', 'author-1', {
        stars: 5,
        text: 'raced',
      });

      expect(result.stars).toBe(5);
    });
  });

  describe('createIntroRequest', () => {
    it('404s when the landlord is not live', async () => {
      landlords.findOne.mockResolvedValue(null);

      await expect(
        service.createIntroRequest('ghost', 'user-1', { name: 'Sam' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('stores the intro request and returns its id and status', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      introRequests.save.mockResolvedValue({
        id: 'intro-1',
        status: LandlordIntroRequestStatus.Pending,
      });

      const result = await service.createIntroRequest(
        'friendly-landlord',
        'user-1',
        { name: 'Sam', note: 'hi' },
      );

      expect(introRequests.create).toHaveBeenCalledWith(
        expect.objectContaining({ landlordId: 'landlord-1', userId: 'user-1' }),
      );
      expect(result).toEqual({
        id: 'intro-1',
        status: LandlordIntroRequestStatus.Pending,
      });
    });
  });

  describe('adminCreate', () => {
    it('creates an admin landlord directly Live with no submitter', async () => {
      landlords.exists.mockResolvedValue(false);
      landlords.save.mockImplementation((row: unknown) =>
        Promise.resolve(makeLandlord({ ...(row as object) })),
      );

      await service.adminCreate('admin-1', { name: 'Studio Owner' });

      expect(landlords.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: LandlordStatus.Live,
          submittedByUserId: null,
        }),
      );
    });

    it('gives up with a 409 after exhausting slug attempts', async () => {
      landlords.exists.mockResolvedValue(false);
      landlords.save.mockRejectedValue(uniqueViolation());

      await expect(
        service.adminCreate('admin-1', { name: 'Clash' }),
      ).rejects.toThrow(ConflictException);
    });

    // M1 (storage-key impersonation): the photo field is exempt from the strict
    // interceptor rule (staff-curated, multi-editor), so the service refuses a
    // foreign photo key on create (no stored baseline to match).
    it('rejects a new foreign photo key on create', async () => {
      const OTHER_ID = '22222222-2222-2222-2222-222222222222';
      const FILE_SEGMENT = '33333333-3333-3333-3333-333333333333';
      const foreignPhoto = `listing-photos/${OTHER_ID}/${FILE_SEGMENT}.jpg`;

      await expect(
        service.adminCreate('admin-1', {
          name: 'Studio Owner',
          photo: foreignPhoto,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(landlords.save).not.toHaveBeenCalled();
    });
  });

  describe('update / setStatus / remove', () => {
    it('update 404s an unknown id', async () => {
      landlords.findOne.mockResolvedValue(null);

      await expect(
        service.update('admin-1', 'x', { name: 'Y' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('update applies only the present fields', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord({ name: 'Old' }));
      landlords.save.mockImplementation((row: unknown) => Promise.resolve(row));

      const result = await service.update('admin-1', 'landlord-1', {
        name: 'New Name',
      });

      expect(result.name).toBe('New Name');
    });

    // M1 (storage-key impersonation): a foreign photo key is allowed on update
    // ONLY when it is already the stored value.
    it('update rejects a foreign photo the landlord does not already carry', async () => {
      const OTHER_ID = '22222222-2222-2222-2222-222222222222';
      const FILE_SEGMENT = '33333333-3333-3333-3333-333333333333';
      const foreignPhoto = `listing-photos/${OTHER_ID}/${FILE_SEGMENT}.jpg`;
      landlords.findOne.mockResolvedValue(makeLandlord({ photo: '' }));

      await expect(
        service.update('admin-1', 'landlord-1', { photo: foreignPhoto }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(landlords.save).not.toHaveBeenCalled();
    });

    it('update allows re-saving the foreign photo already stored', async () => {
      const OTHER_ID = '22222222-2222-2222-2222-222222222222';
      const FILE_SEGMENT = '33333333-3333-3333-3333-333333333333';
      const foreignPhoto = `listing-photos/${OTHER_ID}/${FILE_SEGMENT}.jpg`;
      landlords.findOne.mockResolvedValue(
        makeLandlord({ photo: foreignPhoto }),
      );
      landlords.save.mockImplementation((row: unknown) => Promise.resolve(row));

      await expect(
        service.update('admin-1', 'landlord-1', { photo: foreignPhoto }),
      ).resolves.toBeDefined();
    });

    it('setStatus flips the moderation status and stamps the decision', async () => {
      landlords.findOne.mockResolvedValue(
        makeLandlord({ status: LandlordStatus.Review }),
      );
      landlords.save.mockImplementation((row: unknown) => Promise.resolve(row));

      const result = await service.setStatus(
        'landlord-1',
        { status: LandlordStatus.Live },
        'moderator-1',
      );

      expect(result.slug).toBe('friendly-landlord');
      expect(landlords.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: LandlordStatus.Live,
          decidedBy: 'moderator-1',
          decidedAt: expect.any(Date) as unknown,
        }),
      );
    });

    // LOC-19. The whole point of the queue: the member who suggested the entry
    // is told it went live, and told where.
    it('setStatus tells the member who suggested the entry', async () => {
      landlords.findOne.mockResolvedValue(
        makeLandlord({
          status: LandlordStatus.Review,
          submittedByUserId: 'member-9',
        }),
      );
      landlords.save.mockImplementation((row: unknown) => Promise.resolve(row));

      await service.setStatus(
        'landlord-1',
        { status: LandlordStatus.Live },
        'moderator-1',
      );

      expect(notifications.create).toHaveBeenCalledWith(
        'member-9',
        NotificationType.LandlordSuggestionDecided,
        expect.objectContaining({
          decision: LandlordStatus.Live,
          landlordSlug: 'friendly-landlord',
          landlordName: 'Friendly Landlord',
        }),
      );
    });

    it('setStatus refuses to hold a suggested entry back with no reason', async () => {
      landlords.findOne.mockResolvedValue(
        makeLandlord({
          status: LandlordStatus.Live,
          submittedByUserId: 'member-9',
        }),
      );

      await expect(
        service.setStatus(
          'landlord-1',
          { status: LandlordStatus.Review },
          'moderator-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(landlords.save).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('setStatus is idempotent: re-deciding the same state notifies nobody', async () => {
      landlords.findOne.mockResolvedValue(
        makeLandlord({
          status: LandlordStatus.Live,
          submittedByUserId: 'member-9',
        }),
      );

      await service.setStatus(
        'landlord-1',
        { status: LandlordStatus.Live },
        'moderator-1',
      );

      expect(landlords.save).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('remove 404s an unknown id', async () => {
      landlords.findOne.mockResolvedValue(null);

      await expect(service.remove('x')).rejects.toThrow(NotFoundException);
    });

    it('remove deletes the loaded landlord', async () => {
      const landlord = makeLandlord();
      landlords.findOne.mockResolvedValue(landlord);

      await service.remove('landlord-1');

      expect(landlords.remove).toHaveBeenCalledWith(landlord);
    });

    it('remove refuses to delete a member-suggested entry with no reason', async () => {
      landlords.findOne.mockResolvedValue(
        makeLandlord({ submittedByUserId: 'member-9' }),
      );

      await expect(service.remove('landlord-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(landlords.remove).not.toHaveBeenCalled();
    });

    it('remove tells the member who suggested the entry, with the reason', async () => {
      landlords.findOne.mockResolvedValue(
        makeLandlord({ submittedByUserId: 'member-9' }),
      );

      await service.remove(
        'landlord-1',
        'This is a letting agency, not a landlord.',
      );

      expect(landlords.remove).toHaveBeenCalled();
      expect(notifications.create).toHaveBeenCalledWith(
        'member-9',
        NotificationType.LandlordSuggestionDecided,
        expect.objectContaining({
          decision: 'removed',
          landlordSlug: 'friendly-landlord',
          reason: 'This is a letting agency, not a landlord.',
        }),
      );
    });
  });

  describe('removeRecommendation', () => {
    it('404s an unknown recommendation', async () => {
      recommendations.findOne.mockResolvedValue(null);

      await expect(service.removeRecommendation('x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('removes an existing recommendation', async () => {
      const rec = makeRec();
      recommendations.findOne.mockResolvedValue(rec);

      await service.removeRecommendation('rec-1');

      expect(recommendations.remove).toHaveBeenCalledWith(rec);
    });
  });

  describe('listIntroRequests', () => {
    it('returns an empty page when the filter slug matches no landlord', async () => {
      landlords.findOne.mockResolvedValue(null);

      await expect(
        service.listIntroRequests({ landlord: 'ghost' }),
      ).resolves.toEqual({ items: [], total: 0, page: 1, pageSize: PAGE_SIZE });
      expect(introRequests.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('maps intro requests and embeds their target landlord', async () => {
      const request = makeIntroRequest();
      introRequests.createQueryBuilder.mockReturnValue(
        makePaginatedBuilder([request], 1),
      );
      landlords.find.mockResolvedValue([makeLandlord()]);

      const result = await service.listIntroRequests({});

      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        id: 'intro-1',
        landlordSlug: 'friendly-landlord',
        landlordName: 'Friendly Landlord',
      });
    });
  });

  describe('triageIntroRequest', () => {
    it('404s an unknown request', async () => {
      introRequests.findOne.mockResolvedValue(null);

      await expect(
        service.triageIntroRequest('x', { action: 'accepted' }, 'moderator-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('accepts a request, stamps the decision, and re-embeds the landlord', async () => {
      introRequests.findOne.mockResolvedValue(makeIntroRequest());
      introRequests.save.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );
      landlords.find.mockResolvedValue([makeLandlord()]);

      const result = await service.triageIntroRequest(
        'intro-1',
        { action: 'accepted' },
        'moderator-1',
      );

      expect(introRequests.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: LandlordIntroRequestStatus.Accepted,
          decidedBy: 'moderator-1',
          decidedAt: expect.any(Date) as unknown,
        }),
      );
      expect(result.landlordSlug).toBe('friendly-landlord');
    });

    // LOC-19. A member handed over a name, a note and a contact detail to ask
    // for this. The answer reaches them.
    it('tells the member who asked, naming the landlord', async () => {
      introRequests.findOne.mockResolvedValue(
        makeIntroRequest({ userId: 'member-9' }),
      );
      introRequests.save.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );
      landlords.find.mockResolvedValue([makeLandlord()]);

      await service.triageIntroRequest(
        'intro-1',
        { action: 'accepted' },
        'moderator-1',
      );

      expect(notifications.create).toHaveBeenCalledWith(
        'member-9',
        NotificationType.LandlordIntroRequestDecided,
        expect.objectContaining({
          decision: 'accepted',
          landlordSlug: 'friendly-landlord',
          landlordName: 'Friendly Landlord',
        }),
      );
    });

    it('maps the "declined" action onto the Declined status and forwards the reason', async () => {
      introRequests.findOne.mockResolvedValue(
        makeIntroRequest({ id: 'intro-2', userId: 'member-9' }),
      );
      introRequests.save.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );
      landlords.find.mockResolvedValue([makeLandlord()]);

      await service.triageIntroRequest(
        'intro-2',
        { action: 'declined', reason: 'They have nothing free until spring.' },
        'moderator-1',
      );

      expect(introRequests.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: LandlordIntroRequestStatus.Declined,
          decisionReason: 'They have nothing free until spring.',
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'member-9',
        NotificationType.LandlordIntroRequestDecided,
        expect.objectContaining({
          decision: 'declined',
          reason: 'They have nothing free until spring.',
        }),
      );
    });

    it('refuses a decline with no reason', async () => {
      introRequests.findOne.mockResolvedValue(
        makeIntroRequest({ userId: 'member-9' }),
      );

      await expect(
        service.triageIntroRequest(
          'intro-1',
          { action: 'declined', reason: '   ' },
          'moderator-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(introRequests.save).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('is idempotent: re-answering the same way notifies nobody twice', async () => {
      introRequests.findOne.mockResolvedValue(
        makeIntroRequest({
          userId: 'member-9',
          status: LandlordIntroRequestStatus.Accepted,
          decidedAt: new Date('2026-01-04T00:00:00.000Z'),
          decidedBy: 'moderator-1',
        }),
      );
      landlords.find.mockResolvedValue([makeLandlord()]);

      await service.triageIntroRequest(
        'intro-1',
        { action: 'accepted' },
        'moderator-2',
      );

      expect(introRequests.save).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });
});

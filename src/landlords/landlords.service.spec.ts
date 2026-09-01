import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
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
// `andWhere` is on here because the aggregate now carries the
// `landlord_recommendation` takedown exclusion in-query.
type RatingQueryBuilderStub = {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  getRawOne: jest.Mock;
};

const ratingQbStub = (): RatingQueryBuilderStub => {
  const qb: RatingQueryBuilderStub = {
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    getRawOne: jest.fn().mockResolvedValue({ average: null, count: '0' }),
  };
  qb.select.mockReturnValue(qb);
  qb.addSelect.mockReturnValue(qb);
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
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
  let contentModeration: {
    stateFor: jest.Mock;
    statesFor: jest.Mock;
    applyAction: jest.Mock;
    revert: jest.Mock;
  };
  // The takedown/restore pair opens its own transaction, because
  // `ContentModerationService`'s writes take the caller's `EntityManager` so
  // they can enlist in `ModerationService`'s action transaction. The stub runs
  // the callback straight through with a sentinel manager.
  let dataSource: { transaction: jest.Mock };
  const transactionManager = { sentinel: 'entity-manager' };
  let adminQueueNotifications: { announce: jest.Mock };

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
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
      statesFor: jest.fn().mockResolvedValue(new Map()),
      applyAction: jest.fn().mockResolvedValue(undefined),
      revert: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(
        (runInTransaction: (manager: unknown) => Promise<unknown>) =>
          runInTransaction(transactionManager),
      ),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

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
        { provide: ContentModerationService, useValue: contentModeration },
        { provide: DataSource, useValue: dataSource },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
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

    it('drops moderator-taken-down entries in-query, so the page and total agree', async () => {
      const builder = makePaginatedBuilder([], 0);
      landlords.createQueryBuilder.mockReturnValue(builder);

      await service.browse({ page: 1 });

      // A NOT EXISTS subquery (no join, so `paginate`'s skip/take stays
      // correct) bound to the `landlord` subject type, matching hidden OR
      // removed.
      // A NOT EXISTS subquery, so no join is added and the offset pagination
      // above stays correct. Both `hidden_at` and `removed_at` withhold.
      const takedownParams = { landlordSubjectType: 'landlord' };
      expect(builder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('NOT EXISTS'),
        takedownParams,
      );
      expect(builder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"content_moderation"'),
        takedownParams,
      );
      expect(builder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"cm"."hidden_at" IS NOT NULL'),
        takedownParams,
      );
      expect(builder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"cm"."removed_at" IS NOT NULL'),
        takedownParams,
      );
    });
  });

  describe('detail', () => {
    it('404s an unknown or non-live slug', async () => {
      landlords.findOne.mockResolvedValue(null);

      await expect(service.detail('ghost')).rejects.toThrow(NotFoundException);
    });

    it('404s a live entry a moderator hid', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(service.detail('friendly-landlord')).rejects.toThrow(
        NotFoundException,
      );
      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'landlord',
        'friendly-landlord',
      );
    });

    it('404s a live entry a moderator removed', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: true,
      });

      await expect(service.detail('friendly-landlord')).rejects.toThrow(
        NotFoundException,
      );
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

    it('tells the landlord-suggestion queue that a suggestion landed', async () => {
      landlords.exists.mockResolvedValue(false);
      landlords.save.mockImplementation((row: unknown) =>
        Promise.resolve(
          makeLandlord({ ...(row as object), id: 'landlord-new' }),
        ),
      );

      await service.suggest('user-1', { name: 'New One' });

      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.LandlordSuggestions,
        'landlord-new',
      );
    });

    it('tells nobody when the affirming pledge has not been accepted', async () => {
      affirmingPledge.requireAccepted.mockRejectedValue(
        new Error('AFFIRMING_PLEDGE_REQUIRED'),
      );

      await expect(
        service.suggest('user-1', { name: 'New One' }),
      ).rejects.toThrow();
      expect(landlords.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
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

    it('404s a taken-down entry, so it collects no new public rating', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(
        service.recommend('friendly-landlord', 'author-1', {
          stars: 5,
          text: 'x',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(recommendations.save).not.toHaveBeenCalled();
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

    it('404s a taken-down entry, so it collects no new intro request', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: true,
      });

      await expect(
        service.createIntroRequest('friendly-landlord', 'user-1', {
          name: 'Sam',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(introRequests.save).not.toHaveBeenCalled();
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

    it('tells the landlord-intro-request queue that a request landed', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      introRequests.save.mockResolvedValue({
        id: 'intro-1',
        status: LandlordIntroRequestStatus.Pending,
      });

      await service.createIntroRequest('friendly-landlord', 'user-1', {
        name: 'Sam',
      });

      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.LandlordIntroRequests,
        'intro-1',
      );
    });

    it('tells nobody when the verification step-up is refused', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      verification.requireLevel.mockRejectedValue(
        new Error('VERIFICATION_REQUIRED'),
      );

      await expect(
        service.createIntroRequest('friendly-landlord', 'user-1', {
          name: 'Sam',
        }),
      ).rejects.toThrow();
      expect(introRequests.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
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

  // The takedown replaced a `repository.remove` hard delete. These cover the
  // property that made the replacement worth making: a moderator can undo it,
  // and while it stands the recommendation is absent from every read and every
  // aggregate rather than merely absent from the list.
  describe('takeDownRecommendation', () => {
    const note = 'Names the reporter\u2019s employer and street.';

    it('404s an unknown recommendation', async () => {
      recommendations.findOne.mockResolvedValue(null);

      await expect(
        service.takeDownRecommendation('rec-1', 'mod-1', { note }),
      ).rejects.toThrow(NotFoundException);
      expect(contentModeration.applyAction).not.toHaveBeenCalled();
    });

    it('refuses a takedown with no note, and writes nothing', async () => {
      recommendations.findOne.mockResolvedValue(makeRec());

      await expect(
        service.takeDownRecommendation('rec-1', 'mod-1', { note: '   ' }),
      ).rejects.toThrow(BadRequestException);
      expect(contentModeration.applyAction).not.toHaveBeenCalled();
    });

    it('writes a reversible content_moderation row keyed by the recommendation uuid', async () => {
      recommendations.findOne.mockResolvedValue(makeRec());

      await service.takeDownRecommendation('rec-1', 'mod-1', {
        note,
        reasonCode: 'doxxing',
      });

      expect(contentModeration.applyAction).toHaveBeenCalledWith(
        transactionManager,
        {
          subjectType: 'landlord_recommendation',
          subjectId: 'rec-1',
          action: 'hide_content',
          actorId: 'mod-1',
          reasonCode: 'doxxing',
          note,
        },
      );
      // The row itself is untouched, which is what makes the takedown
      // reversible at all.
      expect(recommendations.remove).not.toHaveBeenCalled();
      expect(recommendations.delete).not.toHaveBeenCalled();
    });

    it('defaults to the lighter action, so remove_content has to be asked for', async () => {
      recommendations.findOne.mockResolvedValue(makeRec());

      await service.takeDownRecommendation('rec-1', 'mod-1', { note });

      expect(contentModeration.applyAction).toHaveBeenCalledWith(
        transactionManager,
        expect.objectContaining({ action: 'hide_content' }),
      );
    });

    it('escalates to remove_content when the moderator asks for it', async () => {
      recommendations.findOne.mockResolvedValue(makeRec());

      await service.takeDownRecommendation('rec-1', 'mod-1', {
        note,
        action: 'remove_content',
      });

      expect(contentModeration.applyAction).toHaveBeenCalledWith(
        transactionManager,
        expect.objectContaining({ action: 'remove_content' }),
      );
    });

    it('answers with the recommendation carrying its new takedown state', async () => {
      recommendations.findOne.mockResolvedValue(makeRec());
      contentModeration.statesFor.mockResolvedValue(
        new Map([['rec-1', { hidden: true, removed: false }]]),
      );

      const result = await service.takeDownRecommendation('rec-1', 'mod-1', {
        note,
      });

      expect(result).toMatchObject({
        id: 'rec-1',
        moderation: { hidden: true, removed: false },
      });
    });
  });

  describe('restoreRecommendation', () => {
    it('404s an unknown recommendation', async () => {
      recommendations.findOne.mockResolvedValue(null);

      await expect(service.restoreRecommendation('rec-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(contentModeration.revert).not.toHaveBeenCalled();
    });

    it('lifts the takedown, putting the warning and its stars back', async () => {
      recommendations.findOne.mockResolvedValue(makeRec());

      const result = await service.restoreRecommendation('rec-1');

      expect(contentModeration.revert).toHaveBeenCalledWith(
        transactionManager,
        'landlord_recommendation',
        'rec-1',
      );
      expect(result.moderation).toEqual({ hidden: false, removed: false });
    });

    it('is idempotent on a recommendation carrying no takedown', async () => {
      recommendations.findOne.mockResolvedValue(makeRec());
      contentModeration.statesFor.mockResolvedValue(new Map());

      await expect(
        service.restoreRecommendation('rec-1'),
      ).resolves.toMatchObject({
        moderation: { hidden: false, removed: false },
      });
    });
  });

  // A taken-down recommendation has to be gone from EVERY read and EVERY
  // aggregate. While the takedown was a hard delete that came for free; a soft
  // one that any read forgets to filter is a withheld warning still readable,
  // or a score still counting stars nobody can see.
  describe('takedown visibility', () => {
    it('withholds a taken-down recommendation from the public detail list', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      recommendations.find.mockResolvedValue([
        makeRec({ id: 'rec-1' }),
        makeRec({ id: 'rec-2', authorUserId: 'author-2' }),
      ]);
      contentModeration.statesFor.mockResolvedValue(
        new Map([['rec-2', { hidden: true, removed: false }]]),
      );

      const detail = await service.detail('friendly-landlord');

      expect(detail.recommendations.map((rec) => rec.id)).toEqual(['rec-1']);
    });

    it('withholds a REMOVED recommendation too, not only a hidden one', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      recommendations.find.mockResolvedValue([makeRec({ id: 'rec-1' })]);
      contentModeration.statesFor.mockResolvedValue(
        new Map([['rec-1', { hidden: true, removed: true }]]),
      );

      const detail = await service.detail('friendly-landlord');

      expect(detail.recommendations).toEqual([]);
    });

    it("excludes taken-down stars from the entry's headline rating IN-QUERY", async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      const ratingQb = ratingQbStub();
      recommendations.createQueryBuilder.mockReturnValue(ratingQb);

      await service.detail('friendly-landlord');

      // In-query, not post-query: the aggregate deliberately runs over EVERY
      // row rather than the capped page, so a post-query filter here could only
      // ever see the page and would leave the headline score disagreeing with
      // the list under it.
      expect(ratingQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('"content_moderation"'),
        { recommendationSubjectType: 'landlord_recommendation' },
      );
    });

    it('excludes taken-down stars from the browse grid ratings', async () => {
      landlords.createQueryBuilder.mockReturnValue(
        makePaginatedBuilder([makeLandlord()], 1),
      );
      recommendations.find.mockResolvedValue([
        makeRec({ id: 'rec-1', stars: 5 }),
        makeRec({ id: 'rec-2', stars: 1, authorUserId: 'author-2' }),
      ]);
      contentModeration.statesFor.mockResolvedValue(
        new Map([['rec-2', { hidden: true, removed: false }]]),
      );

      const result = await service.browse({ page: 1 });

      // 5 alone, never (5 + 1) / 2.
      expect(result.items[0]?.rating).toEqual({ score: '5.0', count: 1 });
    });

    it('excludes taken-down stars from the admin console list ratings too', async () => {
      landlords.createQueryBuilder.mockReturnValue(
        makePaginatedBuilder([makeLandlord()], 1),
      );
      recommendations.find.mockResolvedValue([
        makeRec({ id: 'rec-1', stars: 5 }),
        makeRec({ id: 'rec-2', stars: 1, authorUserId: 'author-2' }),
      ]);
      contentModeration.statesFor.mockResolvedValue(
        new Map([['rec-2', { hidden: true, removed: false }]]),
      );

      const result = await service.listForAdmin({ page: 1 });

      expect(result.items[0]?.rating).toEqual({ score: '5.0', count: 1 });
    });

    it('still SHOWS a taken-down recommendation to staff, flagged, so it can be lifted', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      recommendations.find.mockResolvedValue([makeRec({ id: 'rec-1' })]);
      contentModeration.statesFor.mockResolvedValue(
        new Map([['rec-1', { hidden: true, removed: false }]]),
      );

      const rows = await service.listRecommendationsForAdmin('landlord-1');

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 'rec-1',
        moderation: { hidden: true, removed: false },
      });
    });
  });

  // `author_user_id` is `ON DELETE SET NULL` since
  // `SetNullLandlordRecommendationAuthorFk1797900000000`, so a warning survives
  // its author leaving. Nothing downstream may assume there is an author.
  describe('a recommendation whose author erased their account', () => {
    it('renders with no byline instead of throwing, and keeps its stars', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      recommendations.find.mockResolvedValue([
        makeRec({ id: 'rec-1', authorUserId: null, stars: 2 }),
      ]);

      const detail = await service.detail('friendly-landlord');

      expect(detail.recommendations).toHaveLength(1);
      expect(detail.recommendations[0]).toMatchObject({
        id: 'rec-1',
        member: null,
        name: '',
        initials: '',
        stars: 2,
      });
      // A stable tint still comes back, falling back to the row's own id.
      expect(detail.recommendations[0]?.tint).toBeDefined();
    });

    it('never sends a NULL author id to the profile or verification lookups', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      recommendations.find.mockResolvedValue([
        makeRec({ id: 'rec-1', authorUserId: null }),
        makeRec({ id: 'rec-2', authorUserId: 'author-2' }),
      ]);

      await service.detail('friendly-landlord');

      expect(verification.levelsForUsers).toHaveBeenCalledWith(['author-2']);
    });

    it('falls back to the email verification floor for the erased author', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      recommendations.find.mockResolvedValue([
        makeRec({ id: 'rec-1', authorUserId: null }),
      ]);

      const detail = await service.detail('friendly-landlord');

      expect(detail.recommendations[0]?.verificationLevel).toBe(
        VerificationLevel.Email,
      );
    });

    it('shows staff the same anonymised row rather than failing the console', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      recommendations.find.mockResolvedValue([
        makeRec({ id: 'rec-1', authorUserId: null }),
      ]);

      const rows = await service.listRecommendationsForAdmin('landlord-1');

      expect(rows[0]).toMatchObject({ id: 'rec-1', member: null });
    });
  });

  // The report path (PRD-47d): a member points a complaint at ONE
  // recommendation instead of the whole directory entry. The id is the handle
  // that makes that possible, so the public DTO carrying it is the contract.
  describe('the public recommendation DTO carries its report handle', () => {
    it('exposes the recommendation id to a member reader', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      recommendations.find.mockResolvedValue([makeRec({ id: 'rec-1' })]);

      const detail = await service.detail('friendly-landlord');

      expect(detail.recommendations[0]?.id).toBe('rec-1');
    });

    it('exposes the id and nothing else new: no author user id leaks', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      recommendations.find.mockResolvedValue([makeRec()]);

      const detail = await service.detail('friendly-landlord');

      expect(Object.keys(detail.recommendations[0] ?? {}).sort()).toEqual([
        'createdAt',
        'id',
        'initials',
        'member',
        'name',
        'stars',
        'text',
        'tint',
        'verificationLevel',
      ]);
    });

    it('hands the same id back from the write, so a fresh rating is reportable', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord());
      recommendations.findOne.mockResolvedValue(null);
      recommendations.save.mockResolvedValue(makeRec({ id: 'rec-9' }));

      const saved = await service.recommend('friendly-landlord', 'author-1', {
        stars: 4,
        text: 'Fixed the boiler the same week.',
      });

      expect(saved.id).toBe('rec-9');
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

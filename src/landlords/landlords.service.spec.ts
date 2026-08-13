import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { POSTGRES_UNIQUE_VIOLATION } from '../common/db-errors';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import {
  LandlordIntroRequest,
  LandlordIntroRequestStatus,
} from './entities/landlord-intro-request.entity';
import { LandlordRecommendation } from './entities/landlord-recommendation.entity';
import { Landlord, LandlordStatus } from './entities/landlord.entity';
import { LandlordsService } from './landlords.service';

type RepoMock = Record<string, jest.Mock>;
type QueryBuilderStub = Record<string, jest.Mock>;

function makePaginatedBuilder(
  rows: unknown[],
  total: number,
): QueryBuilderStub {
  const builder: QueryBuilderStub = {};
  for (const method of ['where', 'andWhere', 'orderBy', 'skip', 'take']) {
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

function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('duplicate key'), {
    code: POSTGRES_UNIQUE_VIOLATION,
  });
}

describe('LandlordsService', () => {
  let service: LandlordsService;
  let landlords: RepoMock;
  let recommendations: RepoMock;
  let introRequests: RepoMock;
  let profiles: RepoMock;
  let verification: {
    requireLevel: jest.Mock;
    levelForUser: jest.Mock;
    levelsForUsers: jest.Mock;
  };
  let affirmingPledge: { requireAccepted: jest.Mock };

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
    };
    introRequests = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: unknown) => row),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
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
      ],
    }).compile();

    service = module.get(LandlordsService);
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

      await service.adminCreate({ name: 'Studio Owner' });

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

      await expect(service.adminCreate({ name: 'Clash' })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('update / setStatus / remove', () => {
    it('update 404s an unknown id', async () => {
      landlords.findOne.mockResolvedValue(null);

      await expect(service.update('x', { name: 'Y' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('update applies only the present fields', async () => {
      landlords.findOne.mockResolvedValue(makeLandlord({ name: 'Old' }));
      landlords.save.mockImplementation((row: unknown) => Promise.resolve(row));

      const result = await service.update('landlord-1', { name: 'New Name' });

      expect(result.name).toBe('New Name');
    });

    it('setStatus flips the moderation status', async () => {
      landlords.findOne.mockResolvedValue(
        makeLandlord({ status: LandlordStatus.Review }),
      );
      landlords.save.mockImplementation((row: unknown) => Promise.resolve(row));

      const result = await service.setStatus('landlord-1', LandlordStatus.Live);

      expect(result.slug).toBe('friendly-landlord');
      expect(landlords.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: LandlordStatus.Live }),
      );
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
    it('returns an empty list when the filter slug matches no landlord', async () => {
      landlords.findOne.mockResolvedValue(null);

      await expect(service.listIntroRequests('ghost')).resolves.toEqual([]);
      expect(introRequests.find).not.toHaveBeenCalled();
    });

    it('maps intro requests and embeds their target landlord', async () => {
      const request = {
        id: 'intro-1',
        landlordId: 'landlord-1',
        name: 'Sam',
        note: null,
        contactEmail: null,
        status: LandlordIntroRequestStatus.Pending,
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
      } as LandlordIntroRequest;
      introRequests.find.mockResolvedValue([request]);
      landlords.find.mockResolvedValue([makeLandlord()]);

      const result = await service.listIntroRequests();

      expect(result[0]).toMatchObject({
        id: 'intro-1',
        landlordSlug: 'friendly-landlord',
        landlordName: 'Friendly Landlord',
      });
    });
  });

  describe('triageIntroRequest', () => {
    it('404s an unknown request', async () => {
      introRequests.findOne.mockResolvedValue(null);

      await expect(service.triageIntroRequest('x', 'accepted')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('accepts a request and re-embeds the landlord in the DTO', async () => {
      introRequests.findOne.mockResolvedValue({
        id: 'intro-1',
        landlordId: 'landlord-1',
        name: 'Sam',
        note: null,
        contactEmail: null,
        status: LandlordIntroRequestStatus.Pending,
        createdAt: new Date(),
      });
      introRequests.save.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );
      landlords.find.mockResolvedValue([makeLandlord()]);

      const result = await service.triageIntroRequest('intro-1', 'accepted');

      expect(introRequests.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: LandlordIntroRequestStatus.Accepted,
        }),
      );
      expect(result.landlordSlug).toBe('friendly-landlord');
    });

    it('maps the "declined" action onto the Declined status', async () => {
      introRequests.findOne.mockResolvedValue({
        id: 'intro-2',
        landlordId: 'landlord-1',
        name: 'Sam',
        note: null,
        contactEmail: null,
        status: LandlordIntroRequestStatus.Pending,
        createdAt: new Date(),
      });
      introRequests.save.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );
      landlords.find.mockResolvedValue([makeLandlord()]);

      await service.triageIntroRequest('intro-2', 'declined');

      expect(introRequests.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: LandlordIntroRequestStatus.Declined,
        }),
      );
    });
  });
});

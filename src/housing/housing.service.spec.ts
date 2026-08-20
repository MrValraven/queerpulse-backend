import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { POSTGRES_UNIQUE_VIOLATION } from '../common/db-errors';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import {
  CoopJoinRequest,
  JoinRequestStatus,
} from './entities/coop-join-request.entity';
import { CoopRelocationRequest } from './entities/coop-relocation-request.entity';
import {
  CoopCtaKind,
  HousingCoop,
  HousingPhase,
} from './entities/housing-coop.entity';
import { HousingService } from './housing.service';

type RepoMock = Record<string, jest.Mock>;
type QueryBuilderStub = Record<string, jest.Mock>;

/** Fluent `createQueryBuilder` chain: every builder method returns the builder;
 *  the terminal `getMany` resolves to whatever rows the test supplies. */
function makeQueryBuilderStub(rows: unknown[] = []): QueryBuilderStub {
  const builder: QueryBuilderStub = {};
  for (const method of [
    'leftJoinAndSelect',
    'where',
    'andWhere',
    'orderBy',
    'take',
  ]) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }
  builder.getMany = jest.fn().mockResolvedValue(rows);
  return builder;
}

function makeCoop(overrides: Partial<HousingCoop> = {}): HousingCoop {
  return {
    id: 'coop-1',
    slug: 'rainbow-commons',
    name: 'Rainbow Commons',
    nameEm: null,
    city: 'Lisbon',
    area: 'Arroios',
    householdCount: 4,
    phase: HousingPhase.Forming,
    progress: 20,
    operational: false,
    operationalSince: null,
    formingSince: null,
    description: 'A forming queer housing co-op.',
    shareAmountEuros: null,
    monthlyEuros: null,
    sharesAreTarget: false,
    ctaKind: CoopCtaKind.Join,
    faces: [],
    published: true,
    operatorVerified: false,
    ...overrides,
  } as unknown as HousingCoop;
}

/** A Postgres unique-violation as TypeORM surfaces it. */
function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('duplicate key'), {
    code: POSTGRES_UNIQUE_VIOLATION,
  });
}

describe('HousingService', () => {
  let service: HousingService;
  // Declared with the exact method shape (rather than the bare `RepoMock`
  // index-signature alias) so `coops.find.mockResolvedValue(...)`-style
  // chained access doesn't see `noUncheckedIndexedAccess`'s `| undefined`.
  let coops: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let joinRequests: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let relocationRequests: RepoMock;
  let affirmingPledge: { requireAccepted: jest.Mock };

  beforeEach(async () => {
    coops = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: unknown) => row),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    joinRequests = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: unknown) => row),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub()),
    };
    relocationRequests = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: unknown) => row),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub()),
    };
    affirmingPledge = {
      requireAccepted: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HousingService,
        { provide: getRepositoryToken(HousingCoop), useValue: coops },
        {
          provide: getRepositoryToken(CoopJoinRequest),
          useValue: joinRequests,
        },
        {
          provide: getRepositoryToken(CoopRelocationRequest),
          useValue: relocationRequests,
        },
        { provide: AffirmingPledgeService, useValue: affirmingPledge },
      ],
    }).compile();

    service = module.get(HousingService);
  });

  describe('listPublished', () => {
    it('returns only published co-ops as DTOs, oldest first', async () => {
      coops.find.mockResolvedValue([makeCoop()]);

      const result = await service.listPublished();

      expect(coops.find).toHaveBeenCalledWith({
        where: { published: true },
        order: { createdAt: 'ASC' },
      });
      expect(result).toHaveLength(1);
      // DTO drops createdAt/updatedAt/joinRequests — assert the mapped shape.
      expect(result[0]).toMatchObject({
        slug: 'rainbow-commons',
        published: true,
      });
      expect(result[0]).not.toHaveProperty('createdAt');
    });
  });

  describe('createJoinRequest', () => {
    it('404s when the co-op is not published/known', async () => {
      coops.findOne.mockResolvedValue(null);

      await expect(
        service.createJoinRequest(
          'ghost',
          { name: 'Sam', householdSize: '2' },
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(joinRequests.save).not.toHaveBeenCalled();
    });

    it('persists a Pending request against the resolved co-op and returns its id', async () => {
      coops.findOne.mockResolvedValue(makeCoop());
      joinRequests.save.mockResolvedValue({ id: 'request-9' });

      const result = await service.createJoinRequest(
        'rainbow-commons',
        { name: 'Sam', householdSize: '2', note: 'excited' },
        'user-1',
      );

      expect(coops.findOne).toHaveBeenCalledWith({
        where: { slug: 'rainbow-commons', published: true },
      });
      expect(joinRequests.create).toHaveBeenCalledWith(
        expect.objectContaining({
          coopId: 'coop-1',
          name: 'Sam',
          householdSize: '2',
          note: 'excited',
          userId: 'user-1',
          status: JoinRequestStatus.Pending,
        }),
      );
      expect(result).toEqual({ id: 'request-9' });
    });

    it('stores a null note and a null userId for an anonymous applicant', async () => {
      coops.findOne.mockResolvedValue(makeCoop());
      joinRequests.save.mockResolvedValue({ id: 'request-10' });

      await service.createJoinRequest(
        'rainbow-commons',
        { name: 'Anon', householdSize: '1' },
        null,
      );

      expect(joinRequests.create).toHaveBeenCalledWith(
        expect.objectContaining({ note: null, userId: null }),
      );
    });
  });

  describe('createCoop', () => {
    const dto = {
      slug: 'new-coop',
      name: 'New Coop',
      city: 'Porto',
      area: 'Bonfim',
      description: 'x',
    } as never;

    it('rejects a slug already taken (pre-check) with a 409', async () => {
      coops.findOne.mockResolvedValue(makeCoop());

      await expect(service.createCoop(dto)).rejects.toThrow(ConflictException);
      expect(coops.save).not.toHaveBeenCalled();
    });

    it('defaults the nullable/array columns and returns the created DTO', async () => {
      coops.findOne.mockResolvedValue(null);
      coops.save.mockImplementation((row: HousingCoop) =>
        Promise.resolve(makeCoop({ ...row, id: 'coop-new' })),
      );

      const result = await service.createCoop(dto);

      expect(coops.create).toHaveBeenCalledWith(
        expect.objectContaining({
          nameEm: null,
          operationalSince: null,
          shareAmountEuros: null,
          monthlyEuros: null,
          faces: [],
        }),
      );
      expect(result.id).toBe('coop-new');
    });

    it('maps a lost slug race (23505) from save into a 409 Conflict', async () => {
      coops.findOne.mockResolvedValue(null);
      coops.save.mockRejectedValue(uniqueViolation());

      await expect(service.createCoop(dto)).rejects.toThrow(ConflictException);
    });

    it('rethrows a non-unique save error untouched', async () => {
      coops.findOne.mockResolvedValue(null);
      coops.save.mockRejectedValue(new Error('connection reset'));

      await expect(service.createCoop(dto)).rejects.toThrow('connection reset');
    });
  });

  describe('updateCoop', () => {
    it('404s when the id is unknown', async () => {
      coops.findOne.mockResolvedValue(null);

      await expect(service.updateCoop('coop-x', { name: 'X' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('merges the patch onto the loaded row and saves', async () => {
      const existing = makeCoop();
      coops.findOne.mockResolvedValue(existing);
      coops.save.mockImplementation((row: unknown) => Promise.resolve(row));

      const result = await service.updateCoop('coop-1', { name: 'Renamed' });

      expect(coops.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'coop-1', name: 'Renamed' }),
      );
      expect(result.name).toBe('Renamed');
    });

    it('maps a slug clash on save to a 409', async () => {
      coops.findOne.mockResolvedValue(makeCoop());
      coops.save.mockRejectedValue(uniqueViolation());

      await expect(
        service.updateCoop('coop-1', { slug: 'taken' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('deleteCoop', () => {
    it('404s when nothing was deleted', async () => {
      coops.delete.mockResolvedValue({ affected: 0 });

      await expect(service.deleteCoop('coop-x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('resolves when a row was removed', async () => {
      coops.delete.mockResolvedValue({ affected: 1 });

      await expect(service.deleteCoop('coop-1')).resolves.toBeUndefined();
    });
  });

  describe('listJoinRequests', () => {
    it('caps the unfiltered list and never scopes by co-op slug', async () => {
      const builder = makeQueryBuilderStub([]);
      joinRequests.createQueryBuilder.mockReturnValue(builder);

      await service.listJoinRequests();

      expect(builder.take).toHaveBeenCalledWith(DEFAULT_LIST_LIMIT);
      expect(builder.where).not.toHaveBeenCalled();
    });

    it('scopes to a single co-op when a slug is supplied and maps the rows', async () => {
      const row = {
        id: 'request-1',
        name: 'Sam',
        householdSize: '2',
        note: null,
        status: JoinRequestStatus.Pending,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        coop: { slug: 'rainbow-commons', name: 'Rainbow Commons' },
      };
      const builder = makeQueryBuilderStub([row]);
      joinRequests.createQueryBuilder.mockReturnValue(builder);

      const result = await service.listJoinRequests('rainbow-commons');

      expect(builder.where).toHaveBeenCalledWith('coop.slug = :coopSlug', {
        coopSlug: 'rainbow-commons',
      });
      expect(result[0]).toMatchObject({
        id: 'request-1',
        coop: { slug: 'rainbow-commons', name: 'Rainbow Commons' },
      });
    });
  });

  describe('triageJoinRequest', () => {
    it('404s on an unknown request id', async () => {
      joinRequests.findOne.mockResolvedValue(null);

      await expect(
        service.triageJoinRequest('request-x', 'accepted'),
      ).rejects.toThrow(NotFoundException);
    });

    it('accepts a request, persists the Accepted status, and re-reads with the coop relation', async () => {
      const request = {
        id: 'request-1',
        status: JoinRequestStatus.Pending,
      } as CoopJoinRequest;
      joinRequests.findOne
        .mockResolvedValueOnce(request)
        .mockResolvedValueOnce({
          ...request,
          status: JoinRequestStatus.Accepted,
          name: 'Sam',
          householdSize: '2',
          note: null,
          createdAt: new Date(),
          coop: { slug: 'rainbow-commons', name: 'Rainbow Commons' },
        });

      const result = await service.triageJoinRequest('request-1', 'accepted');

      expect(joinRequests.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: JoinRequestStatus.Accepted }),
      );
      // Second read hydrates the coop relation for the DTO.
      expect(joinRequests.findOne).toHaveBeenLastCalledWith({
        where: { id: 'request-1' },
        relations: { coop: true },
      });
      expect(result.status).toBe(JoinRequestStatus.Accepted);
    });

    it('maps the "declined" action onto the Declined status', async () => {
      const request = {
        id: 'request-2',
        status: JoinRequestStatus.Pending,
      } as CoopJoinRequest;
      joinRequests.findOne
        .mockResolvedValueOnce(request)
        .mockResolvedValueOnce({
          ...request,
          status: JoinRequestStatus.Declined,
          name: 'Sam',
          householdSize: '2',
          note: null,
          createdAt: new Date(),
          coop: { slug: 'rainbow-commons', name: 'Rainbow Commons' },
        });

      await service.triageJoinRequest('request-2', 'declined');

      expect(joinRequests.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: JoinRequestStatus.Declined }),
      );
    });
  });
});

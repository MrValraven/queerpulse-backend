import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { Event } from '../events/entities/event.entity';
import { MagazineIssue } from '../magazine/entities/magazine-issue.entity';
import { SafeSpaceNomination } from '../safe-space-nominations/entities/safe-space-nomination.entity';
import { UsersService } from '../users/users.service';
import { PressContact } from './entities/press-contact.entity';
import { PressCoverage } from './entities/press-coverage.entity';
import { buildPressKitFacts } from './press-kit-response';
import { PressKitService } from './press-kit.service';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default — mirrors `landing.service.spec.ts`'s `qbStub`.
function qbStub() {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['select', 'setLock']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getRawOne = jest.fn().mockResolvedValue(undefined);
  return qb;
}

function makeCoverage(overrides: Partial<PressCoverage>): PressCoverage {
  return {
    id: 'coverage-id',
    source: 'The Example Times',
    title: 'QueerPulse profiled',
    meta: 'Feature',
    publishedOn: '2026-01-01',
    url: 'https://example.com/story',
    position: 0,
    active: true,
    createdBy: 'admin-id',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeContact(overrides: Partial<PressContact>): PressContact {
  return {
    id: 'contact-id',
    name: 'Alex Rivera',
    role: 'Press lead',
    description: 'Handles media enquiries.',
    languages: 'EN, PT',
    email: 'press@example.com',
    avatarUrl: null,
    position: 0,
    active: true,
    createdBy: 'admin-id',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('PressKitService', () => {
  let service: PressKitService;
  let pressCoverage: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let pressContacts: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let events: { count: jest.Mock };
  let safeSpaceNominations: { count: jest.Mock };
  let magazineIssues: { count: jest.Mock };
  let communities: { count: jest.Mock };
  let usersService: { countActiveMembers: jest.Mock };
  let manager: {
    createQueryBuilder: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    pressCoverage = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    pressContacts = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    events = { count: jest.fn().mockResolvedValue(0) };
    safeSpaceNominations = { count: jest.fn().mockResolvedValue(0) };
    magazineIssues = { count: jest.fn().mockResolvedValue(0) };
    communities = { count: jest.fn().mockResolvedValue(0) };
    usersService = { countActiveMembers: jest.fn().mockResolvedValue(0) };
    manager = {
      createQueryBuilder: jest.fn(() => qbStub()),
      create: jest.fn((_entity: unknown, value: object) => value),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
    };
    dataSource = {
      transaction: jest.fn(
        async (callback: (manager: unknown) => Promise<unknown>) =>
          callback(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PressKitService,
        { provide: getRepositoryToken(PressCoverage), useValue: pressCoverage },
        { provide: getRepositoryToken(PressContact), useValue: pressContacts },
        { provide: getRepositoryToken(Event), useValue: events },
        {
          provide: getRepositoryToken(SafeSpaceNomination),
          useValue: safeSpaceNominations,
        },
        {
          provide: getRepositoryToken(MagazineIssue),
          useValue: magazineIssues,
        },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: UsersService, useValue: usersService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(PressKitService);
  });

  describe('getPressKit — facts', () => {
    it('derives every fact from its count, formatted and in order', async () => {
      usersService.countActiveMembers.mockResolvedValue(1847);
      communities.count.mockResolvedValue(42);
      events.count.mockResolvedValue(128);
      safeSpaceNominations.count.mockResolvedValue(30);
      magazineIssues.count.mockResolvedValue(9);

      const result = await service.getPressKit();

      expect(result.facts).toEqual([
        { key: 'founded', value: '2024' },
        { key: 'activeMembers', value: '1,847' },
        { key: 'communities', value: '42' },
        { key: 'gatherings', value: '128' },
        { key: 'safeSpaces', value: '30' },
        { key: 'magazineIssues', value: '9' },
      ]);
    });

    it('counts only public communities, published events, and approved safe spaces', async () => {
      await service.getPressKit();

      expect(communities.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ accessTier: 'public' }),
      });
      expect(events.count).toHaveBeenCalledWith({
        where: { status: 'published' },
      });
      expect(safeSpaceNominations.count).toHaveBeenCalledWith({
        where: { status: 'approved' },
      });
    });
  });

  describe('buildPressKitFacts — omission & formatting', () => {
    it('omits a fact whose source value is null rather than fabricating it', () => {
      const facts = buildPressKitFacts({
        foundedYear: null,
        activeMembers: 5,
        communities: 1,
        gatherings: 2,
        safeSpaces: 3,
        magazineIssues: 4,
      });

      expect(facts.map((fact) => fact.key)).toEqual([
        'activeMembers',
        'communities',
        'gatherings',
        'safeSpaces',
        'magazineIssues',
      ]);
      expect(facts.find((fact) => fact.key === 'founded')).toBeUndefined();
    });

    it('formats thousands with a comma', () => {
      const facts = buildPressKitFacts({
        foundedYear: '2024',
        activeMembers: 12345,
        communities: 0,
        gatherings: 0,
        safeSpaces: 0,
        magazineIssues: 0,
      });

      expect(facts.find((fact) => fact.key === 'activeMembers')?.value).toBe(
        '12,345',
      );
    });
  });

  describe('getPressKit — lists', () => {
    it('reads both lists filtered to active and ordered by position', async () => {
      await service.getPressKit();

      expect(pressCoverage.find).toHaveBeenCalledWith({
        where: { active: true },
        order: { position: 'ASC' },
      });
      expect(pressContacts.find).toHaveBeenCalledWith({
        where: { active: true },
        order: { position: 'ASC' },
      });
    });

    it('maps rows to the public DTO shape without leaking internal columns', async () => {
      pressCoverage.find.mockResolvedValue([
        makeCoverage({ id: 'c-1', position: 0 }),
      ]);
      pressContacts.find.mockResolvedValue([
        makeContact({ id: 'p-1', position: 0 }),
      ]);

      const result = await service.getPressKit();

      // Exactly the public fields — no position/active/createdBy/timestamps.
      expect(result.coverage).toEqual([
        {
          id: 'c-1',
          source: 'The Example Times',
          title: 'QueerPulse profiled',
          meta: 'Feature',
          publishedOn: '2026-01-01',
          url: 'https://example.com/story',
        },
      ]);
      expect(result.contacts).toEqual([
        {
          id: 'p-1',
          name: 'Alex Rivera',
          role: 'Press lead',
          description: 'Handles media enquiries.',
          languages: 'EN, PT',
          email: 'press@example.com',
          avatarUrl: null,
        },
      ]);
    });
  });

  describe('listAdminCoverage', () => {
    it('returns every row (active and inactive) with position and active', async () => {
      pressCoverage.find.mockResolvedValue([
        makeCoverage({ id: 'c-1', position: 0, active: true }),
        makeCoverage({ id: 'c-2', position: 1, active: false }),
      ]);

      const result = await service.listAdminCoverage();

      expect(pressCoverage.find).toHaveBeenCalledWith({
        order: { position: 'ASC' },
      });
      expect(result.map((row) => [row.id, row.position, row.active])).toEqual([
        ['c-1', 0, true],
        ['c-2', 1, false],
      ]);
    });
  });

  describe('reorderCoverage', () => {
    it("rejects when orderedIds does not match the list's current ids", async () => {
      manager.createQueryBuilder.mockImplementation(() => {
        const qb = qbStub();
        qb.getMany = jest
          .fn()
          .mockResolvedValue([
            makeCoverage({ id: 'c-a' }),
            makeCoverage({ id: 'c-b' }),
          ]);
        return qb;
      });

      await expect(
        service.reorderCoverage({ orderedIds: ['c-a'] }), // missing c-b
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('rewrites positions to contiguous 0..n-1 in the given id order', async () => {
      const store = [
        makeCoverage({ id: 'c-a', position: 5 }),
        makeCoverage({ id: 'c-b', position: 6 }),
      ];
      manager.createQueryBuilder.mockImplementation(() => {
        const qb = qbStub();
        qb.getMany = jest.fn().mockResolvedValue(store);
        return qb;
      });
      pressCoverage.find.mockResolvedValue(store);

      await service.reorderCoverage({ orderedIds: ['c-b', 'c-a'] });

      expect(manager.save).toHaveBeenCalledTimes(1);
      const savedRows = manager.save.mock.calls[0][0] as PressCoverage[];
      expect(savedRows.map((row) => [row.id, row.position])).toEqual([
        ['c-b', 0],
        ['c-a', 1],
      ]);
    });
  });
});

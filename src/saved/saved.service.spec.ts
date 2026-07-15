import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ListSavedQuery } from './dto/list-saved.query';
import { SavedItemBodyDto } from './dto/saved-item-body.dto';
import { SavedItem, SavedKind } from './entities/saved-item.entity';
import { SavedService } from './saved.service';

// Chainable query-builder stub (mirrors `communities.service.spec.ts`'s
// `qbStub`) whose terminal method resolves to an empty page by default.
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere', 'orderBy']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.skip = jest.fn().mockReturnValue(qb);
  qb.take = jest.fn().mockReturnValue(qb);
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

describe('SavedService', () => {
  let service: SavedService;
  let repo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  const now = new Date('2026-07-15T12:00:00.000Z');

  const row = (overrides: Partial<SavedItem> = {}): SavedItem => ({
    id: 'row-1',
    userId: 'u1',
    subjectType: SavedKind.Article,
    subjectId: 'coming-out-guide',
    title: 'Coming Out: A Guide',
    href: '/magazine/coming-out-guide',
    meta: 'QueerPulse Editorial',
    description: 'A gentle primer.',
    readTime: '6 min',
    createdAt: now,
    ...overrides,
  });

  beforeEach(async () => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v: Partial<SavedItem>) => v),
      save: jest.fn((v: Partial<SavedItem>) =>
        Promise.resolve({ id: 'new-id', createdAt: now, ...v }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => qbStub()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SavedService,
        { provide: getRepositoryToken(SavedItem), useValue: repo },
      ],
    }).compile();

    service = module.get(SavedService);
  });

  describe('list', () => {
    it('scopes the query to the caller and orders newest-first', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[row()], 1]);
      repo.createQueryBuilder.mockReturnValue(qb);

      const query: ListSavedQuery = {};
      const result = await service.list('u1', query);

      expect(qb.where).toHaveBeenCalledWith('saved.userId = :userId', {
        userId: 'u1',
      });
      expect(qb.orderBy).toHaveBeenCalledWith('saved.createdAt', 'DESC');
      expect(qb.andWhere).not.toHaveBeenCalled();

      // Page-number envelope — matches the frontend's `Paginated<T>` from
      // `shared/api/refs.ts` (`{items,total,page,pageSize}`), NOT the cursor
      // `{data,pageInfo}` shape, since `getSaved` in `saved.api.ts` reads
      // `res.items` directly.
      expect(result).toEqual({
        items: [
          {
            id: 'article:coming-out-guide',
            kind: SavedKind.Article,
            title: 'Coming Out: A Guide',
            href: '/magazine/coming-out-guide',
            meta: 'QueerPulse Editorial',
            description: 'A gentle primer.',
            readTime: '6 min',
            savedAt: now.toISOString(),
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    });

    it('filters by kind when provided', async () => {
      const qb = qbStub();
      repo.createQueryBuilder.mockReturnValue(qb);

      await service.list('u1', { kind: SavedKind.Job });

      expect(qb.andWhere).toHaveBeenCalledWith('saved.subjectType = :kind', {
        kind: SavedKind.Job,
      });
    });

    it('normalizes a missing/invalid page to 1', async () => {
      const qb = qbStub();
      repo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.list('u1', { page: 0 });

      expect(result.page).toBe(1);
    });

    it('omits optional presentational fields when absent', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([
        [row({ href: null, meta: null, description: null, readTime: null })],
        1,
      ]);
      repo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.list('u1', {});

      expect(result.items[0]).toEqual({
        id: 'article:coming-out-guide',
        kind: SavedKind.Article,
        title: 'Coming Out: A Guide',
        savedAt: now.toISOString(),
      });
    });
  });

  describe('put (upsert)', () => {
    const body: SavedItemBodyDto = {
      kind: SavedKind.Article,
      title: 'Coming Out: A Guide',
      href: '/magazine/coming-out-guide',
      meta: 'QueerPulse Editorial',
      description: 'A gentle primer.',
      readTime: '6 min',
    };

    it('creates a new row when none exists for (user, subject)', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.put('u1', 'article:coming-out-guide', body);

      expect(repo.findOne).toHaveBeenCalledWith({
        where: {
          userId: 'u1',
          subjectType: SavedKind.Article,
          subjectId: 'coming-out-guide',
        },
      });
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          subjectType: SavedKind.Article,
          subjectId: 'coming-out-guide',
          title: 'Coming Out: A Guide',
          href: '/magazine/coming-out-guide',
          meta: 'QueerPulse Editorial',
          description: 'A gentle primer.',
          readTime: '6 min',
        }),
      );
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('updates the existing row instead of inserting a duplicate (idempotent PUT)', async () => {
      repo.findOne.mockResolvedValue(row());

      await service.put('u1', 'article:coming-out-guide', {
        ...body,
        title: 'Coming Out: An Updated Guide',
      });

      expect(repo.update).toHaveBeenCalledWith(
        'row-1',
        expect.objectContaining({ title: 'Coming Out: An Updated Guide' }),
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('defaults optional fields to null', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.put('u1', 'job:senior-eng', {
        kind: SavedKind.Job,
        title: 'Senior Engineer',
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          href: null,
          meta: null,
          description: null,
          readTime: null,
        }),
      );
    });

    it('rejects when the id kind does not match body.kind', async () => {
      await expect(
        service.put('u1', 'article:coming-out-guide', {
          ...body,
          kind: SavedKind.Job,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('rejects a malformed id', async () => {
      await expect(service.put('u1', 'not-composite', body)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('remove', () => {
    it('deletes scoped to (user, subject) parsed from the composite id', async () => {
      await service.remove('u1', 'film:pride-1994');

      expect(repo.delete).toHaveBeenCalledWith({
        userId: 'u1',
        subjectType: SavedKind.Film,
        subjectId: 'pride-1994',
      });
    });

    it('rejects a malformed id', async () => {
      await expect(service.remove('u1', 'nope')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});

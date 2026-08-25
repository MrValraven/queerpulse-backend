import { ConflictException, NotFoundException } from '@nestjs/common';
import { POSTGRES_UNIQUE_VIOLATION } from '../common/db-errors';
import { SavedItem, SavedKind } from '../saved/entities/saved-item.entity';
import { CollectionsService } from './collections.service';
import { CollectionItem } from './entities/collection-item.entity';
import { Collection } from './entities/collection.entity';

const now = new Date('2026-08-05T10:00:00.000Z');

function collectionRow(overrides: Partial<Collection> = {}): Collection {
  return {
    id: 'col-1',
    ownerId: 'owner-1',
    name: 'Faves',
    emoji: null,
    cover: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function itemRow(overrides: Partial<CollectionItem> = {}): CollectionItem {
  return {
    collectionId: 'col-1',
    subjectKind: SavedKind.Article,
    subjectId: 'coming-out-guide',
    createdAt: now,
    ...overrides,
  } as CollectionItem;
}

function savedRow(overrides: Partial<SavedItem> = {}): SavedItem {
  return {
    id: 'saved-1',
    userId: 'owner-1',
    subjectType: SavedKind.Article,
    subjectId: 'coming-out-guide',
    title: 'Coming Out: A Guide',
    href: '/magazine/coming-out-guide',
    meta: null,
    description: null,
    readTime: null,
    createdAt: now,
    ...overrides,
  };
}

// Grouped-count query builder stub for `countItemsByCollection`.
function countQbStub(rows: { collectionId: string; count: string }[]) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['select', 'addSelect', 'where', 'groupBy']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

// Join query builder stub for `listFiledRefs`.
function filedRefsQbStub(rows: { subjectKind: string; subjectId: string }[]) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'innerJoin',
    'where',
    'select',
    'addSelect',
    'distinct',
  ]) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

function build() {
  const collections = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((value: unknown) => value),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
    delete: jest.fn(),
    update: jest
      .fn<Promise<unknown>, [string, Partial<Collection>]>()
      .mockResolvedValue(undefined),
  };
  const collectionItems = {
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    // `addItem` checks "already filed?" before counting toward the cap
    // (CNT-19), so a re-add of an existing item stays a no-op at the ceiling.
    exists: jest.fn().mockResolvedValue(false),
    create: jest.fn((value: unknown) => value),
    save: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    createQueryBuilder: jest.fn(() => countQbStub([])),
  };
  const savedItems = { find: jest.fn().mockResolvedValue([]) };

  const service = new CollectionsService(
    collections as never,
    collectionItems as never,
    savedItems as never,
  );
  return { service, collections, collectionItems, savedItems };
}

describe('CollectionsService', () => {
  describe('list', () => {
    it('returns an empty array (and skips the count query) when the owner has none', async () => {
      const { service, collections, collectionItems } = build();
      collections.find.mockResolvedValue([]);

      await expect(service.list('owner-1')).resolves.toEqual([]);
      expect(collectionItems.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('is owner-scoped and attaches the grouped item counts', async () => {
      const { service, collections, collectionItems } = build();
      collections.find.mockResolvedValue([collectionRow()]);
      collectionItems.createQueryBuilder.mockReturnValue(
        countQbStub([{ collectionId: 'col-1', count: '3' }]),
      );

      const result = await service.list('owner-1');

      expect(collections.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ownerId: 'owner-1' } }),
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.itemCount).toBe(3);
    });
  });

  describe('create', () => {
    it('creates under the owner and returns a zero-count DTO', async () => {
      const { service, collections } = build();
      collections.save.mockResolvedValue(collectionRow({ name: 'New' }));

      const result = await service.create('owner-1', { name: 'New' });

      expect(collections.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'owner-1', name: 'New' }),
      );
      expect(result.itemCount).toBe(0);
    });
  });

  describe('owner-scoping (mustOwn)', () => {
    it("rename 404s when the collection is not the caller's", async () => {
      const { service, collections } = build();
      collections.findOne.mockResolvedValue(null); // user B cannot load user A's row

      await expect(
        service.rename('other-user', 'col-1', { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(collections.findOne).toHaveBeenCalledWith({
        where: { id: 'col-1', ownerId: 'other-user' },
      });
    });

    it('getOne 404s for a non-owner', async () => {
      const { service, collections } = build();
      collections.findOne.mockResolvedValue(null);

      await expect(
        service.getOne('other-user', 'col-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('addItem 404s for a non-owner before any write', async () => {
      const { service, collections, collectionItems } = build();
      collections.findOne.mockResolvedValue(null);

      await expect(
        service.addItem('other-user', 'col-1', 'article:x'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(collectionItems.save).not.toHaveBeenCalled();
    });
  });

  describe('rename', () => {
    it('applies provided fields and returns the fresh count', async () => {
      const { service, collections, collectionItems } = build();
      collections.findOne.mockResolvedValue(collectionRow());
      collections.save.mockImplementation((value: unknown) =>
        Promise.resolve(value as Collection),
      );
      collectionItems.count.mockResolvedValue(5);

      const result = await service.rename('owner-1', 'col-1', {
        name: 'Renamed',
      });

      expect(collections.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Renamed' }),
      );
      expect(result.itemCount).toBe(5);
    });
  });

  describe('remove', () => {
    it('deletes owner-scoped and 404s when nothing was affected', async () => {
      const { service, collections } = build();
      collections.delete.mockResolvedValue({ affected: 0 });

      await expect(service.remove('owner-1', 'col-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(collections.delete).toHaveBeenCalledWith({
        id: 'col-1',
        ownerId: 'owner-1',
      });
    });

    it('succeeds when a row was deleted', async () => {
      const { service, collections } = build();
      collections.delete.mockResolvedValue({ affected: 1 });

      await expect(service.remove('owner-1', 'col-1')).resolves.toBeUndefined();
    });
  });

  describe('getOne hydration', () => {
    it('hydrates items from saved snapshots and keeps orphaned items with a fallback', async () => {
      const { service, collections, collectionItems, savedItems } = build();
      collections.findOne.mockResolvedValue(collectionRow());
      collectionItems.find.mockResolvedValue([
        itemRow({ subjectId: 'coming-out-guide' }),
        itemRow({ subjectId: 'orphaned-slug' }),
      ]);
      // Only the first item still has a saved snapshot.
      savedItems.find.mockResolvedValue([
        savedRow({ subjectId: 'coming-out-guide' }),
      ]);

      const detail = await service.getOne('owner-1', 'col-1');

      expect(savedItems.find).toHaveBeenCalledTimes(1); // one batched IN query, no N+1
      expect(detail.items).toHaveLength(2);
      expect(detail.items[0]!.title).toBe('Coming Out: A Guide');
      // Orphan falls back to a bare title keyed off the subject id.
      expect(detail.items[1]!.title).toBe('orphaned-slug');
      expect(detail.itemCount).toBe(2);
    });

    it('bounds the item read with a take cap', async () => {
      const { service, collections, collectionItems } = build();
      collections.findOne.mockResolvedValue(collectionRow());

      await service.getOne('owner-1', 'col-1');

      expect(collectionItems.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 200 }),
      );
    });
  });

  describe('addItem idempotency', () => {
    it('touches the collection on a fresh add', async () => {
      const { service, collections, collectionItems } = build();
      collections.findOne.mockResolvedValue(collectionRow());
      collectionItems.save.mockResolvedValue(undefined);

      await service.addItem('owner-1', 'col-1', 'article:coming-out-guide');

      expect(collections.update).toHaveBeenCalledWith(
        'col-1',
        expect.objectContaining({
          updatedAt: expect.any(Date) as Date,
        }),
      );
    });

    it('swallows the unique-violation of a duplicate add without touching', async () => {
      const { service, collections, collectionItems } = build();
      collections.findOne.mockResolvedValue(collectionRow());
      collectionItems.save.mockRejectedValue({
        code: POSTGRES_UNIQUE_VIOLATION,
        constraint: 'UQ_collection_item_subject',
      });

      await expect(
        service.addItem('owner-1', 'col-1', 'article:coming-out-guide'),
      ).resolves.toBeUndefined();
      expect(collections.update).not.toHaveBeenCalled();
    });

    it('rethrows a non-unique-violation error', async () => {
      const { service, collections, collectionItems } = build();
      collections.findOne.mockResolvedValue(collectionRow());
      collectionItems.save.mockRejectedValue(new Error('connection reset'));

      await expect(
        service.addItem('owner-1', 'col-1', 'article:coming-out-guide'),
      ).rejects.toThrow('connection reset');
    });
  });

  describe('addItem per-collection cap (CNT-19)', () => {
    it('refuses a new item once the collection is full', async () => {
      const { service, collections, collectionItems } = build();
      collections.findOne.mockResolvedValue(collectionRow());
      collectionItems.exists.mockResolvedValue(false);
      collectionItems.count.mockResolvedValue(500);

      await expect(
        service.addItem('owner-1', 'col-1', 'article:coming-out-guide'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(collectionItems.save).not.toHaveBeenCalled();
    });

    it('still no-ops a re-add of an already filed item at the cap', async () => {
      const { service, collections, collectionItems } = build();
      collections.findOne.mockResolvedValue(collectionRow());
      collectionItems.exists.mockResolvedValue(true);
      collectionItems.count.mockResolvedValue(500);
      collectionItems.save.mockRejectedValue({
        code: POSTGRES_UNIQUE_VIOLATION,
        constraint: 'UQ_collection_item_subject',
      });

      await expect(
        service.addItem('owner-1', 'col-1', 'article:coming-out-guide'),
      ).resolves.toBeUndefined();
    });
  });

  describe('listFiledRefs', () => {
    it('joins to the owner-scoped collections and reassembles refs', async () => {
      const { service, collectionItems } = build();
      collectionItems.createQueryBuilder.mockReturnValue(
        filedRefsQbStub([
          { subjectKind: 'article', subjectId: 'coming-out-guide' },
          { subjectKind: 'job', subjectId: 'senior-dev' },
        ]),
      );

      await expect(service.listFiledRefs('owner-1')).resolves.toEqual([
        'article:coming-out-guide',
        'job:senior-dev',
      ]);
    });

    it('returns an empty array when nothing is filed', async () => {
      const { service, collectionItems } = build();
      collectionItems.createQueryBuilder.mockReturnValue(filedRefsQbStub([]));

      await expect(service.listFiledRefs('owner-1')).resolves.toEqual([]);
    });
  });

  describe('removeItem idempotency', () => {
    it('touches only when a row was actually removed', async () => {
      const { service, collections, collectionItems } = build();
      collections.findOne.mockResolvedValue(collectionRow());
      collectionItems.delete.mockResolvedValue({ affected: 1 });

      await service.removeItem('owner-1', 'col-1', 'article:coming-out-guide');

      expect(collections.update).toHaveBeenCalled();
    });

    it('is a silent no-op (no touch) when nothing matched', async () => {
      const { service, collections, collectionItems } = build();
      collections.findOne.mockResolvedValue(collectionRow());
      collectionItems.delete.mockResolvedValue({ affected: 0 });

      await service.removeItem('owner-1', 'col-1', 'article:coming-out-guide');

      expect(collections.update).not.toHaveBeenCalled();
    });
  });
});

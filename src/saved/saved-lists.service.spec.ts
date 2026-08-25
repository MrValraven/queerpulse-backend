import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SavedItem, SavedKind } from './entities/saved-item.entity';
import { SavedListEntry } from './entities/saved-list-entry.entity';
import { SavedList } from './entities/saved-list.entity';
import { SavedListsService } from './saved-lists.service';

const now = new Date('2026-08-20T12:00:00.000Z');

const list = (overrides: Partial<SavedList> = {}): SavedList =>
  ({
    id: 'list-1',
    userId: 'u1',
    name: 'First date',
    isDefault: false,
    shareToken: null,
    sharedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }) as SavedList;

describe('SavedListsService', () => {
  let service: SavedListsService;
  let lists: {
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let entries: {
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let savedItems: { find: jest.Mock; findOne: jest.Mock };
  // Repositories the in-transaction helpers reach for through the manager.
  let managerRepos: Map<unknown, Record<string, jest.Mock>>;
  let dataSource: { transaction: jest.Mock };

  const countsQb = () => {
    const qb: Record<string, jest.Mock> = {};
    for (const method of ['select', 'addSelect', 'where', 'groupBy']) {
      qb[method] = jest.fn().mockReturnValue(qb);
    }
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    return qb;
  };

  beforeEach(async () => {
    lists = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((value: Partial<SavedList>) => value),
      save: jest.fn((value: Partial<SavedList>) =>
        Promise.resolve({
          id: 'list-new',
          createdAt: now,
          updatedAt: now,
          shareToken: null,
          sharedAt: null,
          ...value,
        }),
      ),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    entries = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((value: Partial<SavedListEntry>) => value),
      save: jest.fn((value: Partial<SavedListEntry>) =>
        Promise.resolve({ id: 'entry-1', ...value }),
      ),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => countsQb()),
    };
    savedItems = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };

    managerRepos = new Map<unknown, Record<string, jest.Mock>>([
      [SavedList, lists],
      [SavedListEntry, entries],
      [
        SavedItem,
        {
          findOne: jest.fn().mockResolvedValue(null),
          create: jest.fn((value: Partial<SavedItem>) => value),
          save: jest.fn((value: Partial<SavedItem>) =>
            Promise.resolve({ id: 'item-1', ...value }),
          ),
        },
      ],
    ]);
    dataSource = {
      transaction: jest.fn(
        (
          run: (manager: { getRepository: (t: unknown) => unknown }) => unknown,
        ) =>
          run({ getRepository: (target: unknown) => managerRepos.get(target) }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SavedListsService,
        { provide: getRepositoryToken(SavedList), useValue: lists },
        { provide: getRepositoryToken(SavedListEntry), useValue: entries },
        { provide: getRepositoryToken(SavedItem), useValue: savedItems },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(SavedListsService);
  });

  describe('listLists', () => {
    it('never counts per list — one grouped query for every list', async () => {
      lists.find.mockResolvedValue([list({ id: 'a' }), list({ id: 'b' })]);
      const qb = countsQb();
      qb.getRawMany!.mockResolvedValue([{ listId: 'a', count: '4' }]);
      entries.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listLists('u1');

      expect(entries.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(result[0]?.itemCount).toBe(4);
      expect(result[1]?.itemCount).toBe(0);
    });

    it('never leaks the share token state as shared when it is null', async () => {
      lists.find.mockResolvedValue([list()]);
      const result = await service.listLists('u1');
      expect(result[0]?.isShared).toBe(false);
      expect(result[0]?.shareToken).toBeNull();
    });
  });

  describe('createList', () => {
    it('rejects a name that is only whitespace', async () => {
      await expect(service.createList('u1', { name: '   ' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('caps how many lists one member can keep', async () => {
      lists.count.mockResolvedValue(30);
      await expect(
        service.createList('u1', { name: 'Another' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('deleteList', () => {
    it('refuses to delete the default list', async () => {
      lists.findOne.mockResolvedValue(list({ isDefault: true }));
      await expect(service.deleteList('u1', 'list-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(lists.delete).not.toHaveBeenCalled();
    });

    it('404s somebody else’s list rather than 403ing it', async () => {
      lists.findOne.mockResolvedValue(null);
      await expect(service.deleteList('u1', 'list-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('drops only the memberships, never the saved items', async () => {
      lists.findOne.mockResolvedValue(list());
      await service.deleteList('u1', 'list-1');
      expect(lists.delete).toHaveBeenCalledWith({ id: 'list-1', userId: 'u1' });
      expect(savedItems.find).not.toHaveBeenCalled();
    });
  });

  describe('addItemToList', () => {
    it('rejects when the id kind does not match body.kind', async () => {
      await expect(
        service.addItemToList('u1', 'list-1', 'article:coming-out-guide', {
          kind: SavedKind.Job,
          title: 'Coming Out: A Guide',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    // An item filed under a named list is also saved, so it joins the default
    // list as well: two entry writes, one per list.
    it('files the item in the named list AND in the default list', async () => {
      lists.findOne
        // `loadOwnedOr404` for the named list.
        .mockResolvedValueOnce(list({ id: 'list-1' }))
        // `ensureDefaultListIn` inside the transaction.
        .mockResolvedValueOnce(list({ id: 'list-default', isDefault: true }));

      await service.addItemToList('u1', 'list-1', 'listing:drama-bar', {
        kind: SavedKind.Listing,
        title: 'Drama Bar',
      });

      const linkedListIds = entries.save.mock.calls.map(
        (call) => (call[0] as { listId: string }).listId,
      );
      expect(linkedListIds).toEqual(['list-default', 'list-1']);
    });

    // A member can name a list "Saved" by hand before they ever save anything.
    it('promotes an existing list called Saved rather than colliding with it', async () => {
      lists.findOne
        // `loadOwnedOr404`.
        .mockResolvedValueOnce(list({ id: 'list-1' }))
        // `ensureDefaultListIn`: no default yet...
        .mockResolvedValueOnce(null)
        // ...but the member already has a list by that name.
        .mockResolvedValueOnce(list({ id: 'list-saved', name: 'Saved' }));

      await service.addItemToList('u1', 'list-1', 'listing:drama-bar', {
        kind: SavedKind.Listing,
        title: 'Drama Bar',
      });

      expect(lists.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'list-saved', isDefault: true }),
      );
    });

    it('does not double-link when the named list IS the default list', async () => {
      lists.findOne
        .mockResolvedValueOnce(list({ id: 'list-default', isDefault: true }))
        .mockResolvedValueOnce(list({ id: 'list-default', isDefault: true }));

      await service.addItemToList('u1', 'list-default', 'listing:drama-bar', {
        kind: SavedKind.Listing,
        title: 'Drama Bar',
      });

      expect(entries.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeItemFromList', () => {
    it('refuses on the default list and points at unsaving instead', async () => {
      lists.findOne.mockResolvedValue(list({ isDefault: true }));
      await expect(
        service.removeItemFromList('u1', 'list-1', 'listing:drama-bar'),
      ).rejects.toThrow(BadRequestException);
      expect(entries.delete).not.toHaveBeenCalled();
    });

    it('unlinks without unsaving', async () => {
      lists.findOne.mockResolvedValue(list());
      savedItems.findOne.mockResolvedValue({ id: 'item-1' });

      await service.removeItemFromList('u1', 'list-1', 'listing:drama-bar');

      expect(entries.delete).toHaveBeenCalledWith({
        listId: 'list-1',
        savedItemId: 'item-1',
      });
    });

    it('is idempotent when the item was never in the list', async () => {
      lists.findOne.mockResolvedValue(list());
      savedItems.findOne.mockResolvedValue(null);
      await expect(
        service.removeItemFromList('u1', 'list-1', 'listing:drama-bar'),
      ).resolves.toBeUndefined();
      expect(entries.delete).not.toHaveBeenCalled();
    });
  });

  describe('sharing', () => {
    it('is off until asked for', async () => {
      lists.find.mockResolvedValue([list()]);
      const [only] = await service.listLists('u1');
      expect(only?.isShared).toBe(false);
    });

    it('mints a 64-character hex token on the first share', async () => {
      const target = list();
      lists.findOne.mockResolvedValue(target);
      const result = await service.share('u1', 'list-1');
      expect(result.shareToken).toMatch(/^[0-9a-f]{64}$/);
      expect(result.isShared).toBe(true);
      expect(lists.save).toHaveBeenCalled();
    });

    // Rotating the token would silently break a link the member already sent.
    it('returns the same token on a repeat share', async () => {
      const alreadyShared = list({ shareToken: 'a'.repeat(64), sharedAt: now });
      lists.findOne.mockResolvedValue(alreadyShared);
      const result = await service.share('u1', 'list-1');
      expect(result.shareToken).toBe('a'.repeat(64));
      expect(lists.save).not.toHaveBeenCalled();
    });

    it('revoking clears the token, so every copy of the link dies', async () => {
      lists.findOne.mockResolvedValue(
        list({ shareToken: 'a'.repeat(64), sharedAt: now }),
      );
      const result = await service.unshare('u1', 'list-1');
      expect(result.shareToken).toBeNull();
      expect(result.sharedAt).toBeNull();
      expect(result.isShared).toBe(false);
    });
  });

  describe('getShared', () => {
    it('404s a malformed token without querying at all', async () => {
      await expect(service.getShared('not-a-token')).rejects.toThrow(
        NotFoundException,
      );
      expect(lists.findOne).not.toHaveBeenCalled();
    });

    it('404s a revoked token the same way it 404s one that never existed', async () => {
      lists.findOne.mockResolvedValue(null);
      await expect(service.getShared('b'.repeat(64))).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the list’s name and items and nothing about its owner', async () => {
      lists.findOne.mockResolvedValue(list({ name: 'Open late' }));
      entries.find.mockResolvedValue([
        { id: 'entry-1', listId: 'list-1', savedItemId: 'item-1' },
      ]);
      savedItems.find.mockResolvedValue([
        {
          id: 'item-1',
          userId: 'u1',
          subjectType: SavedKind.Listing,
          subjectId: 'drama-bar',
          title: 'Drama Bar',
          href: '/local/directory/drama-bar',
          meta: null,
          description: null,
          readTime: null,
          createdAt: now,
        },
      ]);

      const shared = await service.getShared('c'.repeat(64));

      expect(shared.name).toBe('Open late');
      expect(shared.itemCount).toBe(1);
      expect(shared.items[0]?.id).toBe('listing:drama-bar');
      // No owner id, slug, name or avatar anywhere in the payload.
      expect(JSON.stringify(shared)).not.toContain('u1');
    });
  });
});

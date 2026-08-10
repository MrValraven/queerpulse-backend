import { NotFoundException } from '@nestjs/common';
import { EventBookmarksService } from './event-bookmarks.service';

// Chainable insert-builder stub (bookmark uses `.insert().into().values().orIgnore().execute()`).
function insertQbStub() {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['insert', 'into', 'values', 'orIgnore']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.execute = jest.fn().mockResolvedValue(undefined);
  return qb;
}

// Chainable select-builder stub for `listSaved`.
function selectQbStub(rows: unknown[]) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['innerJoin', 'where', 'orderBy', 'offset', 'limit']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

function build() {
  const insertQb = insertQbStub();
  const bookmarks = {
    createQueryBuilder: jest.fn().mockReturnValue(insertQb),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    find: jest.fn().mockResolvedValue([]),
    exists: jest.fn().mockResolvedValue(false),
  };
  const events = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
  };
  const service = new EventBookmarksService(
    bookmarks as never,
    events as never,
  );
  return { service, bookmarks, events, insertQb };
}

describe('EventBookmarksService', () => {
  describe('bookmark', () => {
    it('resolves the slug and inserts idempotently, always reporting bookmarked:true', async () => {
      const { service, events, insertQb } = build();
      events.findOne.mockResolvedValue({ id: 'event-1' });

      const result = await service.bookmark('me', 'pride-picnic');

      expect(insertQb.orIgnore).toHaveBeenCalled(); // ON CONFLICT DO NOTHING
      expect(insertQb.execute).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ bookmarked: true });
    });

    it('404s on an unknown slug', async () => {
      const { service, events } = build();
      events.findOne.mockResolvedValue(null);

      await expect(service.bookmark('me', 'ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('removeBookmark', () => {
    it("deletes the caller's bookmark and reports bookmarked:false", async () => {
      const { service, events, bookmarks } = build();
      events.findOne.mockResolvedValue({ id: 'event-1' });

      const result = await service.removeBookmark('me', 'pride-picnic');

      expect(bookmarks.delete).toHaveBeenCalledWith({
        eventId: 'event-1',
        userId: 'me',
      });
      expect(result).toEqual({ bookmarked: false });
    });

    it('is idempotent — removing an absent bookmark still reports bookmarked:false', async () => {
      const { service, events, bookmarks } = build();
      events.findOne.mockResolvedValue({ id: 'event-1' });
      bookmarks.delete.mockResolvedValue({ affected: 0 });

      await expect(
        service.removeBookmark('me', 'pride-picnic'),
      ).resolves.toEqual({
        bookmarked: false,
      });
    });

    it('404s on an unknown slug', async () => {
      const { service, events } = build();
      events.findOne.mockResolvedValue(null);

      await expect(
        service.removeBookmark('me', 'ghost'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listSaved', () => {
    it('joins bookmarks to events, newest-saved first, bounded by offset/limit', async () => {
      const { service, events } = build();
      const qb = selectQbStub([{ id: 'event-1' }]);
      events.createQueryBuilder.mockReturnValue(qb);

      const result = await service.listSaved('me', 0, 20);

      expect(qb.innerJoin).toHaveBeenCalled();
      expect(qb.orderBy).toHaveBeenCalledWith('b.created_at', 'DESC');
      expect(qb.offset).toHaveBeenCalledWith(0);
      expect(qb.limit).toHaveBeenCalledWith(20);
      expect(result).toEqual([{ id: 'event-1' }]);
    });
  });

  describe('bookmarkedEventIds (batch)', () => {
    it('short-circuits an empty id list without querying', async () => {
      const { service, bookmarks } = build();

      await expect(service.bookmarkedEventIds('me', [])).resolves.toEqual(
        new Set(),
      );
      expect(bookmarks.find).not.toHaveBeenCalled();
    });

    it('resolves the whole page in one query, returning a set of bookmarked ids', async () => {
      const { service, bookmarks } = build();
      bookmarks.find.mockResolvedValue([{ eventId: 'e1' }, { eventId: 'e3' }]);

      const result = await service.bookmarkedEventIds('me', ['e1', 'e2', 'e3']);

      expect(bookmarks.find).toHaveBeenCalledTimes(1);
      expect(result).toEqual(new Set(['e1', 'e3']));
    });
  });

  describe('isBookmarked', () => {
    it('delegates to an existence check', async () => {
      const { service, bookmarks } = build();
      bookmarks.exists.mockResolvedValue(true);

      await expect(service.isBookmarked('me', 'event-1')).resolves.toBe(true);
      expect(bookmarks.exists).toHaveBeenCalledWith({
        where: { userId: 'me', eventId: 'event-1' },
      });
    });
  });
});

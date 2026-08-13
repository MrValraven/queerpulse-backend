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
  for (const method of [
    'innerJoin',
    'where',
    'andWhere',
    'orderBy',
    'offset',
    'limit',
  ]) {
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
  const cohosts = {
    exists: jest.fn().mockResolvedValue(false),
  };
  // Defaults to "always admit" (`assertViewable`) / "pass every fetched
  // event through unfiltered" (`filterViewable`) — individual tests override
  // to exercise the gate/filter itself.
  const audienceGate = {
    assertViewable: jest.fn().mockResolvedValue(undefined),
    filterViewable: jest.fn((events: unknown[]) => Promise.resolve(events)),
  };
  const service = new EventBookmarksService(
    bookmarks as never,
    events as never,
    cohosts as never,
    audienceGate as never,
  );
  return { service, bookmarks, events, cohosts, audienceGate, insertQb };
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

    // Fix round 2 (Task A, write direction): a member cannot bookmark an
    // event they cannot view — gated through the SAME shared
    // `EventAudienceGateService.assertViewable` the RSVP path uses.
    it('gates the write through assertViewable and rejects (404) when the gate rejects', async () => {
      const { service, events, audienceGate, insertQb } = build();
      events.findOne.mockResolvedValue({
        id: 'event-1',
        hostId: 'host',
        visibility: 'network',
      });
      audienceGate.assertViewable.mockRejectedValue(
        new NotFoundException('Event not found'),
      );

      await expect(
        service.bookmark('stranger', 'network-only-gathering'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(insertQb.execute).not.toHaveBeenCalled(); // never persisted
    });

    it('computes isOrganizer from the host id, without a co-host lookup', async () => {
      const { service, events, cohosts, audienceGate } = build();
      events.findOne.mockResolvedValue({ id: 'event-1', hostId: 'host' });

      await service.bookmark('host', 'my-own-event');

      expect(cohosts.exists).not.toHaveBeenCalled();
      expect(audienceGate.assertViewable).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'event-1' }),
        'host',
        true,
      );
    });

    it('computes isOrganizer via a co-host row when the caller is not the host', async () => {
      const { service, events, cohosts, audienceGate } = build();
      events.findOne.mockResolvedValue({ id: 'event-1', hostId: 'host' });
      cohosts.exists.mockResolvedValue(true);

      await service.bookmark('cohost', 'someones-event');

      expect(cohosts.exists).toHaveBeenCalledWith({
        where: { eventId: 'event-1', userId: 'cohost' },
      });
      expect(audienceGate.assertViewable).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'event-1' }),
        'cohost',
        true,
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

    // Fix round 3 (Task A, read direction — corrects fix round 2): a
    // previously-bookmarked event the viewer can no longer VIEW (per the
    // SAME `assertViewable` rules, not the cheaper browse-discovery
    // predicate fix round 2 wrongly reused) must not surface here. The page
    // is fetched WITHOUT a visibility predicate, then run through
    // `EventAudienceGateService.filterViewable` — no `.andWhere` for
    // visibility at all anymore.
    it("filters the fetched page through the shared audience gate's filterViewable", async () => {
      const { service, events, audienceGate } = build();
      const fetched = [{ id: 'still-viewable' }, { id: 'no-longer-viewable' }];
      const qb = selectQbStub(fetched);
      events.createQueryBuilder.mockReturnValue(qb);
      audienceGate.filterViewable.mockResolvedValue([{ id: 'still-viewable' }]);

      const result = await service.listSaved('me', 0, 20);

      expect(audienceGate.filterViewable).toHaveBeenCalledWith(fetched, 'me');
      // The now-unviewable bookmark is dropped — a shorter-than-requested
      // page, by design (see the method's PAGINATION SHAPE NOTE).
      expect(result).toEqual([{ id: 'still-viewable' }]);
    });

    it('does not add any visibility predicate to the SQL query itself (filtering happens post-fetch)', async () => {
      const { service, events } = build();
      const qb = selectQbStub([]);
      events.createQueryBuilder.mockReturnValue(qb);

      await service.listSaved('me', 0, 20);

      expect(qb.andWhere).not.toHaveBeenCalled();
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

import type { EntityManager } from 'typeorm';
import {
  hiddenCommunityIdsFor,
  keepUnlessEveryHostHiddenSql,
} from './hidden-event-communities.sql';

describe('hidden event communities SQL', () => {
  describe('hiddenCommunityIdsFor', () => {
    it('reads the viewer rows and maps them to community ids', async () => {
      const query = jest
        .fn()
        .mockResolvedValue([
          { community_id: 'community-a' },
          { community_id: 'community-b' },
        ]);
      const manager = { query } as unknown as EntityManager;

      const ids = await hiddenCommunityIdsFor(manager, 'viewer-1');

      expect(ids).toEqual(['community-a', 'community-b']);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith(
        'SELECT "community_id" FROM "hidden_event_communities" WHERE "user_id" = $1',
        ['viewer-1'],
      );
    });

    it('answers an empty list when the viewer hides nothing', async () => {
      const manager = {
        query: jest.fn().mockResolvedValue([]),
      } as unknown as EntityManager;

      await expect(hiddenCommunityIdsFor(manager, 'viewer-1')).resolves.toEqual(
        [],
      );
    });
  });

  describe('keepUnlessEveryHostHiddenSql', () => {
    const predicate = keepUnlessEveryHostHiddenSql();

    it('names both guest aliases against the outer event id', () => {
      expect(predicate).toContain('"event_communities" "hidden_any_guest"');
      expect(predicate).toContain('"hidden_any_guest"."event_id" = "e"."id"');
      expect(predicate).toContain('"event_communities" "hidden_guest"');
      expect(predicate).toContain('"hidden_guest"."event_id" = "e"."id"');
    });

    it('counts accepted guests only', () => {
      expect(predicate).toContain(`"hidden_any_guest"."status" = 'accepted'`);
      expect(predicate).toContain(`"hidden_guest"."status" = 'accepted'`);
    });

    it('keeps a gathering with no lead and no accepted guest', () => {
      expect(predicate).toContain('e.community_id IS NULL AND NOT EXISTS');
    });

    it('keeps a gathering whose lead or an accepted guest is still shown', () => {
      expect(predicate).toContain(
        'e.community_id IS NOT NULL AND e.community_id NOT IN (:...hiddenCommunityIds)',
      );
      expect(predicate).toContain(
        '"hidden_guest"."community_id" NOT IN (:...hiddenCommunityIds)',
      );
    });

    it('binds the hiddenCommunityIds parameter alone', () => {
      const boundNames = new Set(
        [...predicate.matchAll(/:(?:\.\.\.)?([A-Za-z]+)/g)].map(
          (match) => match[1],
        ),
      );
      expect([...boundNames]).toEqual(['hiddenCommunityIds']);
    });
  });
});

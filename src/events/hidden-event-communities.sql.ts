import type { EntityManager } from 'typeorm';
import { acceptedGuestExistsSql } from './event-community-hosting';

/**
 * The communities this viewer hid from their events browse
 * (`hidden_event_communities`), as ids. A raw read through the events
 * repository's manager so `EventsService` takes no new constructor argument:
 * its positional constructors in specs stay valid. Served by the table's
 * `(user_id, community_id)` unique index.
 */
export async function hiddenCommunityIdsFor(
  manager: EntityManager,
  viewerId: string,
): Promise<string[]> {
  const rows: Array<{ community_id: string }> = await manager.query(
    'SELECT "community_id" FROM "hidden_event_communities" WHERE "user_id" = $1',
    [viewerId],
  );
  return rows.map((row) => row.community_id);
}

/**
 * The keep predicate for the upcoming browse under alias `e`, bound to
 * `:...hiddenCommunityIds`. A gathering is hidden only when EVERY hosting
 * community is hidden: its lead (`e.community_id`) when it has one, plus each
 * ACCEPTED guest. A gathering with no lead and no accepted guest always stays;
 * one with no lead whose accepted guests are all hidden goes. This is the rule
 * the feed applies to muted communities (`FeedService`, the
 * `mutedCommunityIds` predicate), stated over the viewer's hidden list.
 *
 * Callers skip the predicate when the id list is empty: `IN ()` is invalid
 * SQL. Negated (`NOT (...)`), it selects exactly the gatherings the list
 * removed.
 */
export function keepUnlessEveryHostHiddenSql(): string {
  return `(
    (e.community_id IS NULL AND NOT ${acceptedGuestExistsSql('"e"."id"', 'hidden_any_guest', 'TRUE')})
    OR (e.community_id IS NOT NULL AND e.community_id NOT IN (:...hiddenCommunityIds))
    OR ${acceptedGuestExistsSql('"e"."id"', 'hidden_guest', '"hidden_guest"."community_id" NOT IN (:...hiddenCommunityIds)')}
  )`;
}

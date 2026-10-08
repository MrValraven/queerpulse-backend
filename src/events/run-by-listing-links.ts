import type { EntityManager } from 'typeorm';

/** Which gatherings one clearing pass looks at. */
export type RunByLinkScope =
  { listingId: string } | { eventIds: readonly string[] };

/**
 * Clears "Run by" on every gathering in `scope` that is still ahead (it starts
 * or ends at or after `now`) and whose host no longer owns, or holds an active
 * co-manager seat on, the listing it names. Past gatherings keep the line:
 * they happened under that business.
 *
 * One statement on the caller's `entityManager`, so it commits or rolls back
 * with the change that ended the role. Called by
 * `ListingOwnershipService.transferOwnership` (a listing changes hands, and
 * the seats the transfer revokes go with it), `ListingCoManagersService`
 * (`endSeat`: a co-manager is removed or leaves) and
 * `ContentOwnerErasureService` (an erased host's gatherings pass to a
 * co-host). Asking "does the host still manage it?" covers all three with one
 * rule: whoever lost the role loses the link, and everybody still on the team
 * keeps theirs.
 *
 * Returns how many gatherings changed.
 */
export async function clearUnmanagedFutureRunByLinks(
  entityManager: Pick<EntityManager, 'query'>,
  scope: RunByLinkScope,
  now: Date,
): Promise<number> {
  let scopeCondition: string;
  let scopeValue: string | string[];
  if ('listingId' in scope) {
    scopeCondition = '"event"."run_by_listing_id" = $2';
    scopeValue = scope.listingId;
  } else {
    if (scope.eventIds.length === 0) return 0;
    scopeCondition = '"event"."id" = ANY($2::uuid[])';
    scopeValue = [...scope.eventIds];
  }
  const result: unknown = await entityManager.query(
    `UPDATE "events" AS "event"
        SET "run_by_listing_id" = NULL
      WHERE "event"."run_by_listing_id" IS NOT NULL
        AND ${scopeCondition}
        AND ("event"."start_at" >= $1 OR "event"."end_at" >= $1)
        AND NOT EXISTS (
          SELECT 1 FROM "listings" "listing"
           WHERE "listing"."id" = "event"."run_by_listing_id"
             AND "listing"."owner_id" = "event"."host_id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "listing_co_managers" "seat"
           WHERE "seat"."listing_id" = "event"."run_by_listing_id"
             AND "seat"."user_id" = "event"."host_id"
             AND "seat"."status" = 'active'
        )`,
    [now, scopeValue],
  );
  // node-postgres hands back `[rows, affectedCount]` for an UPDATE sent
  // through `query`.
  const affectedCount: unknown = Array.isArray(result)
    ? (result as unknown[])[1]
    : undefined;
  return typeof affectedCount === 'number' ? affectedCount : 0;
}

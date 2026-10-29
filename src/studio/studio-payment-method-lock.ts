import type { EntityManager } from 'typeorm';

/**
 * Payment-method lock and the three reads that run under it (purchases
 * contract 2.3 and 4.2).
 *
 * A price write takes the release row lock first (`lockReleaseForWrite` or
 * `lockTrackForWrite`) and then this lock. A payment-method write takes this
 * lock alone. Both sides serialise on the same per-persona key, so a price
 * never lands on a persona whose last method is going: the price write counts
 * the methods after the method write committed, and the method write checks
 * for priced items after the price write committed.
 *
 * The lock is transaction-scoped; it is released on commit or rollback, so
 * callers pass the `EntityManager` of the transaction that does the write.
 */
export const PAYMENT_METHODS_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('studio_payment_methods:' || $1::text))`;

/** `$1` persona (subprofile) id. */
export const PAYMENT_METHOD_COUNT_SQL = `SELECT COUNT(*)::int AS "count"
   FROM "studio_payment_methods" "method"
  WHERE "method"."subprofile_id" = $1`;

/**
 * `$1` persona (subprofile) id. True when any release of the persona is
 * priced, or any track on one of its releases is.
 */
export const PERSONA_HAS_ITEMS_FOR_SALE_SQL = `SELECT (
     EXISTS (
       SELECT 1 FROM "studio_releases" "release"
        WHERE "release"."subprofile_id" = $1
          AND "release"."price_mode" <> 'not_for_sale'
     )
     OR EXISTS (
       SELECT 1
         FROM "studio_tracks" "track"
         JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
        WHERE "release"."subprofile_id" = $1
          AND "track"."price_mode" <> 'not_for_sale'
     )
   ) AS "has_items_for_sale"`;

/**
 * `$1` release id, `$2` a track id to leave out (null leaves none out). True
 * when any other track of the release is priced.
 */
export const RELEASE_TRACKS_PRICED_SQL = `SELECT EXISTS (
     SELECT 1 FROM "studio_tracks" "track"
      WHERE "track"."release_id" = $1
        AND ($2::uuid IS NULL OR "track"."id" <> $2::uuid)
        AND "track"."price_mode" <> 'not_for_sale'
   ) AS "has_priced_tracks"`;

/** Takes the persona's payment-methods lock until the transaction ends. */
export async function lockPaymentMethodsOf(
  manager: EntityManager,
  subprofileId: string,
): Promise<void> {
  await manager.query(PAYMENT_METHODS_LOCK_SQL, [subprofileId]);
}

/** How many payment methods the persona lists. */
export async function countPaymentMethods(
  manager: EntityManager,
  subprofileId: string,
): Promise<number> {
  const rows: { count: number }[] = await manager.query(
    PAYMENT_METHOD_COUNT_SQL,
    [subprofileId],
  );
  return rows[0]?.count ?? 0;
}

/** Whether any release or track of the persona is priced. */
export async function personaHasItemsForSale(
  queryable: Pick<EntityManager, 'query'>,
  subprofileId: string,
): Promise<boolean> {
  const rows: { has_items_for_sale: boolean }[] = await queryable.query(
    PERSONA_HAS_ITEMS_FOR_SALE_SQL,
    [subprofileId],
  );
  return rows[0]?.has_items_for_sale === true;
}

/** Whether any track of the release (except `exceptTrackId`) is priced. */
export async function releaseHasPricedTracks(
  manager: EntityManager,
  releaseId: string,
  exceptTrackId: string | null,
): Promise<boolean> {
  const rows: { has_priced_tracks: boolean }[] = await manager.query(
    RELEASE_TRACKS_PRICED_SQL,
    [releaseId, exceptTrackId],
  );
  return rows[0]?.has_priced_tracks === true;
}

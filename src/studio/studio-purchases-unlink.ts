import { EntityManager } from 'typeorm';
import { lockPaymentMethodsOf } from './studio-payment-method-lock';
import { chosenPersonaShowableSql } from './studio-persona-members';

/**
 * Studio purchases (contract 4.7 and the user ruling of 2026-10-28): what an
 * artist persona unlink does to the sales of the persona. Confirmed buyers
 * keep their record and their downloads, served from private copies; pending
 * claims expire; the persona members lose the sales list and the payment
 * methods; every item goes off sale.
 *
 * ENG-447: the pseudonymous persona must carry nothing that ties it to its
 * named past, and each step below removes one such tie.
 * 1. The payment methods go: an IBAN or a phone number names the person
 *    behind the named persona.
 * 2. The releases and their tracks go off sale: a price set while named
 *    would match the two personas on the offer pages.
 * 3. Pending claims expire, since nobody on the persona can answer them
 *    once the sales list is gone. The ids come back so the unlink service
 *    tells each buyer after its transaction commits.
 * 4. Confirmed buyers keep their files: every track a confirmed purchase
 *    would download today (contract 3.7 steps 5 to 8) gets one kept row per
 *    source track and one link per purchase. The kept row holds the live
 *    key only until the private copy lands, since the live key appears in
 *    the re-keyed track's stream URL.
 * 5. Every purchase lets go of the persona; the snapshots keep the record.
 *    The re-key then clears the release and track ids through their
 *    `ON UPDATE SET NULL` keys.
 * 6. Every wall choice naming the persona lets go of it. The flag stays, so
 *    the entry leaves the wall until the buyer picks again.
 *
 * Runs inside the unlink transaction, after the persona row has moved to its
 * fresh id (the purchases follow it through their `ON UPDATE CASCADE` key)
 * and before its releases and tracks get fresh ids. A plain function over the
 * caller's `EntityManager`, like `forgetListeningOfPersona`, so the
 * subprofiles module calls it without importing the Studio module.
 */

/** What the unlink service announces once its transaction commits. */
export interface StudioSalesUnlinkOutcome {
  expiredPurchaseIds: string[];
  keptTrackCount: number;
}

/** Step 1. `$1` is the persona id. */
export const UNLINK_PAYMENT_METHODS_DELETE_SQL = `DELETE FROM "studio_payment_methods" WHERE "subprofile_id" = $1`;

/** Step 2: the releases, then their tracks. `$1` is the persona id. */
export const UNLINK_PRICES_CLEAR_SQL = [
  `UPDATE "studio_releases"
      SET "price_mode" = 'not_for_sale', "price_cents" = NULL
    WHERE "subprofile_id" = $1
      AND "price_mode" <> 'not_for_sale'`,
  `UPDATE "studio_tracks"
      SET "price_mode" = 'not_for_sale', "price_cents" = NULL
    WHERE "release_id" IN (
      SELECT "id" FROM "studio_releases" WHERE "subprofile_id" = $1
    )
      AND "price_mode" <> 'not_for_sale'`,
] as const;

/**
 * Step 3. Wrapped in `WITH` so the Postgres driver hands back the rows (an
 * `UPDATE ... RETURNING` alone resolves to rows and a count). `$1` is the
 * persona id.
 */
export const UNLINK_PENDING_EXPIRE_SQL = `WITH "expired" AS (
  UPDATE "studio_purchases"
     SET "status" = 'expired', "decided_at" = now(), "updated_at" = now()
   WHERE "subprofile_id" = $1 AND "status" = 'pending'
  RETURNING "id"
)
SELECT "id" FROM "expired" ORDER BY "id"`;

/**
 * Step 4. `$1` is the persona id, which the purchases already carry after
 * the persona row moved. `studio_tracks.audio_key` is unique
 * (`UQ_studio_tracks_audio_key`), so the join back from the kept rows is
 * exact. `chosenPersonaShowableSql` is the contract 3.7 step 6 rule: a
 * removed persona or one under a moderator takedown keeps nothing.
 */
export const UNLINK_KEEP_TRACKS_SQL = `WITH "covered" AS (
  SELECT "purchase"."id" AS "purchase_id", "track"."id" AS "track_id", "track"."position" AS "position",
         "track"."title" AS "title", "track"."duration_seconds" AS "duration_seconds",
         "track"."audio_content_type" AS "audio_content_type", "track"."audio_key" AS "audio_key"
    FROM "studio_purchases" "purchase"
    INNER JOIN "studio_tracks" "track"
            ON ("purchase"."item_kind" = 'release' AND "track"."release_id" = "purchase"."release_id")
            OR ("purchase"."item_kind" = 'track' AND "track"."id" = "purchase"."track_id")
    INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
   WHERE "purchase"."subprofile_id" = $1
     AND "purchase"."status" = 'confirmed'
     AND "release"."status" <> 'taken_down'
     AND ${chosenPersonaShowableSql('"release"."subprofile_id"')}
     AND "track"."withheld_at" IS NULL
     AND "track"."audio_key" IS NOT NULL
     AND "track"."audio_content_type" IS NOT NULL
), "kept" AS (
  INSERT INTO "studio_kept_tracks" ("title", "duration_seconds", "audio_content_type", "source_audio_key")
  SELECT DISTINCT ON ("track_id") left("title", 200), "duration_seconds", "audio_content_type", "audio_key"
    FROM "covered"
   ORDER BY "track_id"
  RETURNING "id", "source_audio_key"
), "linked" AS (
  INSERT INTO "studio_purchase_kept_tracks" ("purchase_id", "kept_track_id", "position")
  SELECT "covered"."purchase_id", "kept"."id", "covered"."position"
    FROM "covered"
   INNER JOIN "kept" ON "kept"."source_audio_key" = "covered"."audio_key"
  RETURNING 1
)
SELECT COUNT(*)::int AS "kept_count" FROM "linked"`;

/** Step 5. `$1` is the persona id. */
export const UNLINK_SALES_DETACH_SQL = `UPDATE "studio_purchases"
   SET "subprofile_id" = NULL, "updated_at" = now()
 WHERE "subprofile_id" = $1`;

/** Step 6. `is_shown_as_persona` keeps its value. `$1` is the persona id. */
export const UNLINK_WALL_PERSONA_CLEAR_SQL = `UPDATE "studio_purchases"
   SET "shown_as_subprofile_id" = NULL, "updated_at" = now()
 WHERE "shown_as_subprofile_id" = $1`;

interface ExpiredPurchaseRow {
  id: string;
}

interface KeptCountRow {
  kept_count: number;
}

/** Driver rows as an array; anything else (a unit mock's `undefined`) reads
 *  as no rows. */
function rowsOf<Row>(result: unknown): Row[] {
  return Array.isArray(result) ? (result as Row[]) : [];
}

/**
 * Persona delete: the persona's pending claims expire inside the delete
 * transaction, before the `ON DELETE SET NULL` key lets go of the persona,
 * since nobody can answer them once it is gone. Answers the expired ids,
 * which the caller announces after its transaction commits.
 */
export async function expirePendingSalesOfPersona(
  manager: EntityManager,
  subprofileId: string,
): Promise<string[]> {
  const expiredRows = rowsOf<ExpiredPurchaseRow>(
    await manager.query(UNLINK_PENDING_EXPIRE_SQL, [subprofileId]),
  );
  return expiredRows.map((row) => row.id);
}

/** Runs the six steps in order and answers what the caller announces after
 *  its transaction commits. */
export async function forgetSalesOfPersona(
  manager: EntityManager,
  subprofileId: string,
): Promise<StudioSalesUnlinkOutcome> {
  // The payment-methods lock first, so a sale write that already read a
  // payment method (a price set, a method added) finishes before they go.
  await lockPaymentMethodsOf(manager, subprofileId);
  await manager.query(UNLINK_PAYMENT_METHODS_DELETE_SQL, [subprofileId]);
  for (const statement of UNLINK_PRICES_CLEAR_SQL) {
    await manager.query(statement, [subprofileId]);
  }
  const expiredRows = rowsOf<ExpiredPurchaseRow>(
    await manager.query(UNLINK_PENDING_EXPIRE_SQL, [subprofileId]),
  );
  const keptRows = rowsOf<KeptCountRow>(
    await manager.query(UNLINK_KEEP_TRACKS_SQL, [subprofileId]),
  );
  await manager.query(UNLINK_SALES_DETACH_SQL, [subprofileId]);
  await manager.query(UNLINK_WALL_PERSONA_CLEAR_SQL, [subprofileId]);
  return {
    expiredPurchaseIds: expiredRows.map((row) => row.id),
    keptTrackCount: keptRows.reduce(
      (total, row) => total + Number(row.kept_count),
      0,
    ),
  };
}

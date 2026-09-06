// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-170. Adds `housing_listings.first_live_at`, the marker that stops a
 * saved-search alert from being re-broadcast every time a listing is approved.
 *
 * THE BUG. `HousingListingModerationService` guarded the
 * `HOUSING_LISTING_WENT_LIVE` emit on `!wasLive`, not on "first time ever
 * live". Editing a moderated field knocks a listing back to `review`
 * (fingerprint-diffed, so an identical PATCH does not), which means `wasLive` is
 * false on every re-approval and the event fires again. Neither the
 * saved-search listener nor the notification bundler dedupes: the listener's
 * `seen` set is declared inside its own handler and discarded, and
 * `HousingListingMatch` has no `subjectFor` case so `bundleKeyFor` returns null.
 * Every re-approval therefore wrote a genuinely new "new match" row to every
 * member whose saved search matched. Alerts that repeat get switched off.
 *
 * WHY A FLAG RATHER THAN SUPPRESSING THE EVENT. The event is a true domain fact
 * on a re-approval, and a future consumer that must run on every publication (a
 * search reindex, a cache bust) would silently stop firing if the emit were
 * gated. The event stays unconditional and carries `isFirstGoLive`; only the
 * alert listener acts on it.
 *
 * WHY THE CLAIM IS AT THE EMIT SITE. The listener's module deliberately imports
 * nothing from `HousingListingsModule` and registers only its own entity, so
 * making it write this column would give it write access to another module's
 * table. The moderation service already holds the row it just saved. The claim
 * is a conditional `UPDATE ... WHERE first_live_at IS NULL`, so two concurrent
 * approvals cannot both alert.
 *
 * NEVER CLEARED, deliberately, and this is the opposite of
 * `events.nearly_full_notified_at`, which IS cleared. A gathering that empties
 * and refills is genuinely nearly full again. A home is published once: it is
 * already in browse and already reachable from the member's own saved search,
 * so re-alerting would turn a moderator's corrective take-down into a broadcast
 * and hand a lister a take-down/re-approve loop that reaches every matching
 * inbox.
 *
 * NO INDEX: the column is only ever read by a primary-key-conditioned UPDATE.
 */
export class AddHousingListingFirstLiveAt1817020000000
  implements MigrationInterface
{
  name = 'AddHousingListingFirstLiveAt1817020000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD COLUMN IF NOT EXISTS "first_live_at" TIMESTAMP WITH TIME ZONE`,
    );

    // Backfill 1, exact. Every listing a moderator has ever approved, dated to
    // the FIRST approval. `mod_audit_logs.note` is written by
    // `HousingListingModerationService.writeAuditRow` as `'<ref>: <reason>'` or
    // bare `'<ref>'`, and a ref (QPH-2026-0001) contains no colon, so
    // `split_part(note, ':', 1)` recovers it exactly.
    await queryRunner.query(`
      UPDATE "housing_listings" AS l
      SET "first_live_at" = a."first_approved_at"
      FROM (
        SELECT split_part("note", ':', 1) AS "ref",
               MIN("created_at")          AS "first_approved_at"
        FROM "mod_audit_logs"
        WHERE "action" = 'housing_listing_approved' AND "note" IS NOT NULL
        GROUP BY 1
      ) AS a
      WHERE l."ref" = a."ref" AND l."first_live_at" IS NULL
    `);

    // Backfill 2, fallback for rows published before that audit trail existed.
    // `taken_down` is included because it is only reachable from `live`.
    //
    // KNOWN RESIDUAL GAP, accepted deliberately: a listing that went live before
    // the trail existed, was then edited back to `review`/`question`/`rejected`,
    // and is sitting in one of those states now gets no stamp and will earn ONE
    // repeat alert on its next approval. Widening this to those statuses would be
    // worse: `decided_at` is also set by a plain rejection that never went live,
    // so stamping them would permanently silence a genuine FIRST alert. One
    // duplicate is the cheaper error.
    await queryRunner.query(`
      UPDATE "housing_listings"
      SET "first_live_at" = COALESCE("decided_at", "updated_at", "created_at")
      WHERE "first_live_at" IS NULL
        AND "status" IN ('live', 'taken_down')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN IF EXISTS "first_live_at"`,
    );
  }
}

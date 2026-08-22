import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-HSG-09: makes the "real recorded interaction" premise behind two-sided
 * housing reviews actually hold.
 *
 * Two indexes:
 *
 *  1. `UQ_housing_viewings_open` — PARTIAL unique on
 *     (listing_id, requester_id) WHERE status IN ('requested','accepted').
 *     `HousingViewingsService.request` had no dedupe of any kind, so one member
 *     could open unlimited viewings on a single listing, and every one a lister
 *     accepted became another reviewable "interaction". Partial rather than
 *     full, so a declined/cancelled/completed viewing does not block the member
 *     from ever arranging another visit to the same home.
 *
 *  2. `UQ_housing_reviews_listing_author` — unique on
 *     (listing_id, author_id, author_role). Review uniqueness was per
 *     (viewing_id, author_id) only, so the same member could review one listing
 *     again for each viewing they opened on it. `author_role` is part of the key
 *     because a member can legitimately be BOTH sides across two different
 *     viewings of the same listing (a lister reviewing a guest, and separately a
 *     guest reviewing a lister); this constrains each role to one review.
 *
 * PRE-EXISTING DUPLICATES ARE COLLAPSED, NOT FATAL. This originally created both
 * indexes bare, on the reasoning that failing loudly is safer than silently
 * keeping forgeable review data, and left duplicate resolution to a human. That
 * reasoning assumed a human is present when it runs. It is not: this migration
 * sits inside Railway's automated `preDeployCommand` chain, alongside 30 other
 * migrations shipped in the same commit, under
 * `migrationsTransactionMode: 'each'` (see `src/data-source.ts`). A failure here
 * therefore does not stop at "somebody investigates the duplicates". It aborts
 * the whole batch mid-way, leaves every LATER migration unapplied while the code
 * that depends on them is already live, and the first symptom an operator sees
 * is an unrelated table missing an unrelated column.
 *
 * So both indexes now get a backfill first, in the shape the sibling migration
 * in this same batch already uses (`AddDeletionRequestOpenUniqueIndex`), and the
 * duplicate data is preserved rather than discarded:
 *
 *  - Viewings: all but ONE open row per (listing, requester) move to
 *    `cancelled`, keeping the row the lifecycle would actually act on (an
 *    `accepted` row first, otherwise the newest `requested` one). Cancelling is
 *    a legitimate transition out of both states, so nothing is destroyed.
 *
 *  - Reviews: the OLDEST review per (listing, author, role) is the genuine one;
 *    the extras are exactly what the constraint calls forgeable, so they cannot
 *    stay in the live table. They are COPIED into `housing_reviews_superseded`
 *    before deletion. That satisfies the constraint without a migration quietly
 *    destroying member-authored content, and leaves moderation an actual record
 *    of who piled on reviews via extra viewings. The table is deliberately plain
 *    (no FKs, no enum churn beyond reusing `housing_review_author_role_enum`):
 *    it is an audit trail, never something the app reads.
 *
 * Both are no-ops on a healthy database, and neither is silent after the fact:
 * every archived review is a row in `housing_reviews_superseded`, and every
 * auto-cancelled viewing carries an `updated_at` stamped at deploy time.
 *
 * NOT `CREATE INDEX CONCURRENTLY`: these are unique indexes whose whole purpose
 * is to reject bad rows at creation time, and a concurrent build would need its
 * own non-transactional migration. Both tables are small (viewings are a
 * per-listing handful), so a brief lock is the right trade.
 */
export class AddHousingViewingAndReviewUniqueness1793530600000 implements MigrationInterface {
  name = 'AddHousingViewingAndReviewUniqueness1793530600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Viewings: keep one open row per (listing, requester), cancel the rest.
    await queryRunner.query(`
      UPDATE "housing_viewings" AS v
      SET "status" = 'cancelled', "updated_at" = now()
      WHERE v."status" IN ('requested', 'accepted')
        AND v."id" <> (
          SELECT k."id"
          FROM "housing_viewings" AS k
          WHERE k."listing_id" = v."listing_id"
            AND k."requester_id" = v."requester_id"
            AND k."status" IN ('requested', 'accepted')
          ORDER BY (k."status" = 'accepted') DESC,
                   k."created_at" DESC,
                   k."id" DESC
          LIMIT 1
        )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_housing_viewings_open"
         ON "housing_viewings" ("listing_id", "requester_id")
         WHERE "status" IN ('requested', 'accepted')`,
    );

    // 2. Reviews: archive, then remove, every review after the first a member
    // wrote for a given (listing, role).
    await queryRunner.query(`
      CREATE TABLE "housing_reviews_superseded" (
        "id" uuid NOT NULL,
        "viewing_id" uuid NOT NULL,
        "listing_id" uuid NOT NULL,
        "author_id" uuid NOT NULL,
        "subject_id" uuid NOT NULL,
        "author_role" "housing_review_author_role_enum" NOT NULL,
        "rating" integer NOT NULL,
        "text" character varying(1000) NOT NULL,
        "submitted_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "superseded_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_housing_reviews_superseded" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      WITH ranked AS (
        SELECT "id",
               row_number() OVER (
                 PARTITION BY "listing_id", "author_id", "author_role"
                 ORDER BY "submitted_at" ASC, "created_at" ASC, "id" ASC
               ) AS rn
        FROM "housing_reviews"
      ),
      moved AS (
        DELETE FROM "housing_reviews"
        WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1)
        RETURNING *
      )
      INSERT INTO "housing_reviews_superseded" (
        "id", "viewing_id", "listing_id", "author_id", "subject_id",
        "author_role", "rating", "text", "submitted_at", "created_at",
        "updated_at"
      )
      SELECT "id", "viewing_id", "listing_id", "author_id", "subject_id",
             "author_role", "rating", "text", "submitted_at", "created_at",
             "updated_at"
      FROM moved
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_housing_reviews_listing_author"
         ON "housing_reviews" ("listing_id", "author_id", "author_role")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_housing_reviews_listing_author"`);

    // Reviews ARE reversible: every row removed above is sitting in the archive
    // with its original id, so the live table can be made whole again. Done
    // before the table is dropped, and after the index is gone (the restored
    // rows are precisely the ones that violate it).
    await queryRunner.query(`
      INSERT INTO "housing_reviews" (
        "id", "viewing_id", "listing_id", "author_id", "subject_id",
        "author_role", "rating", "text", "submitted_at", "created_at",
        "updated_at"
      )
      SELECT "id", "viewing_id", "listing_id", "author_id", "subject_id",
             "author_role", "rating", "text", "submitted_at", "created_at",
             "updated_at"
      FROM "housing_reviews_superseded"
    `);
    await queryRunner.query(`DROP TABLE "housing_reviews_superseded"`);

    // The viewing backfill is not reversible: a row cancelled above cannot be
    // told apart from one the member cancelled themselves. Same trade-off, and
    // same wording, as AddDeletionRequestOpenUniqueIndex.
    await queryRunner.query(`DROP INDEX "UQ_housing_viewings_open"`);
  }
}
